"""
SiteGuard Live Monitoring Backend
FastAPI + OpenCV + YOLO + Firebase Admin SDK
"""

import os
import sys
import time
import threading
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from concurrent.futures import ThreadPoolExecutor

# Resolve base project directory and ensure it is on sys.path
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from ultralytics import YOLO

MODEL_PATH = BASE_DIR / "models" / "best.pt"
KEY_PATH = BASE_DIR / "secrets" / "firebase-service-account.json"
VIDEOS_DIR = BASE_DIR / "videos"

CONFIDENCE_THRESHOLD = 0.25
IMAGE_SIZE = 960
COOLDOWN_SECONDS = 10
ANDROID_STREAM_URL = os.environ.get("ANDROID_STREAM_URL", "http://192.168.1.2:8080/video")

# Thread pool for non-blocking Firestore writes
firestore_executor = ThreadPoolExecutor(max_workers=2)

# Initialize Firebase Admin once if credentials exist
firebase_db = None
firebase_initialized = False

try:
    import firebase_admin
    from firebase_admin import credentials, firestore

    if KEY_PATH.exists():
        if not firebase_admin._apps:
            cred = credentials.Certificate(str(KEY_PATH))
            firebase_admin.initialize_app(cred)
        firebase_db = firestore.client()
        firebase_initialized = True
        print("[SiteGuard] Firebase Admin SDK initialized successfully.")
    else:
        print(f"[SiteGuard] Warning: Service account key not found at {KEY_PATH}. Firestore logging disabled.")
except Exception as e:
    print(f"[SiteGuard] Warning: Failed to initialize Firebase Admin: {e}")


# Initialize YOLO Model once (Singleton)
print(f"[SiteGuard] Loading YOLO model from {MODEL_PATH}...")
try:
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Model file not found: {MODEL_PATH}")
    yolo_model = YOLO(str(MODEL_PATH))
    print("[SiteGuard] YOLO model loaded successfully.")
    model_loaded = True
except Exception as e:
    print(f"[SiteGuard] Error loading YOLO model: {e}")
    yolo_model = None
    model_loaded = False


class MonitorEngine:
    """Threaded Video Monitor Engine for YOLO inference and MJPEG streaming."""

    def __init__(self):
        self.state_lock = threading.Lock()
        self.action_lock = threading.Lock()
        self._stop_event = threading.Event()
        self.worker_thread: Optional[threading.Thread] = None

        self.is_running = False
        self.source_id = "helmet.mp4"
        self.source_path = str(VIDEOS_DIR / "helmet.mp4")
        self.cap: Optional[cv2.VideoCapture] = None

        # State metrics
        self.safety_status = "OFFLINE"  # "OFFLINE", "SAFE", "VIOLATION DETECTED", "NO DETECTIONS"
        self.violations_count = 0
        self.hardhat_count = 0
        self.latest_detection: Optional[Dict[str, Any]] = None
        self.total_violations_session = 0
        self.total_events_logged = 0
        self.last_alert_time = 0.0
        self.last_error: Optional[str] = None
        self.fps = 0.0

        # Frame buffers
        self.latest_jpeg: Optional[bytes] = None
        self._generate_offline_frame()

    def _generate_offline_frame(self, message: str = "MONITORING OFFLINE"):
        """Generate a sleek placeholder frame when monitoring is offline."""
        img = np.zeros((480, 720, 3), dtype=np.uint8)
        for y in range(480):
            val = int(24 + (y / 480) * 16)
            img[y, :] = (val, val + 2, val + 8)

        # Border box
        cv2.rectangle(img, (20, 20), (700, 460), (45, 52, 70), 1)

        # Status text
        cv2.putText(
            img, "SiteGuard AI Safety Stream",
            (40, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (230, 235, 245), 2
        )
        cv2.putText(
            img, message,
            (40, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (120, 140, 200), 2
        )
        cv2.putText(
            img, "Select a source and click 'Start Monitoring' to begin.",
            (40, 280), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (160, 165, 180), 1
        )
        cv2.putText(
            img, f"Active Model: {MODEL_PATH.name}  |  Class IDs: 0 (Hardhat), 2 (NO-Hardhat)",
            (40, 430), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (110, 115, 130), 1
        )

        _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        self.latest_jpeg = buf.tobytes()

    def _resolve_source(self, source_id: str):
        if source_id in ("webcam", "0", 0):
            return 0
        if source_id in ("android_camera", "android", "phone"):
            return ANDROID_STREAM_URL
        if str(source_id).startswith(("http://", "https://", "rtsp://")):
            return source_id
        if source_id == "helmet.mp4":
            return str(VIDEOS_DIR / "helmet.mp4")
        if source_id == "no_helmet.mp4":
            return str(VIDEOS_DIR / "no_helmet.mp4")
        p = VIDEOS_DIR / source_id
        if p.exists():
            return str(p)
        return source_id

    def start(self, source_id: str = "helmet.mp4") -> bool:
        with self.action_lock:
            # Stop existing stream and wait for worker to cleanly finish
            self._stop_unsafe()

            self.source_id = source_id
            target = self._resolve_source(source_id)
            self.source_path = str(target)

            # Only check local file existence if not a stream URL
            if isinstance(target, str) and not target.startswith(("http://", "https://", "rtsp://")):
                if not os.path.exists(target):
                    self.last_error = f"Video source file not found: {target}"
                    with self.state_lock:
                        self.safety_status = "OFFLINE"
                        self._generate_offline_frame("SOURCE NOT FOUND")
                    return False

            cap = cv2.VideoCapture(target)
            if not cap.isOpened():
                if isinstance(target, str) and target.startswith(("http://", "https://", "rtsp://")):
                    self.last_error = f"Could not connect to Android stream at {target}. Ensure IP Webcam is running and on the same Wi-Fi."
                else:
                    self.last_error = f"Failed to open video source: {target}"
                with self.state_lock:
                    self.safety_status = "OFFLINE"
                    self._generate_offline_frame("CANNOT OPEN SOURCE")
                return False

            self.cap = cap
            self._stop_event.clear()

            with self.state_lock:
                self.is_running = True
                self.last_error = None
                self.safety_status = "NO DETECTIONS"
                self.violations_count = 0
                self.hardhat_count = 0
                self.latest_detection = None

            self.worker_thread = threading.Thread(
                target=self._process_loop, daemon=True
            )
            self.worker_thread.start()
            print(f"[SiteGuard] Monitoring started with source: {self.source_id}")
            return True

    def _stop_unsafe(self):
        """Internal helper to stop thread and release capture safely."""
        self._stop_event.set()
        thread = self.worker_thread
        self.worker_thread = None

        if thread and thread.is_alive() and threading.current_thread() != thread:
            thread.join(timeout=2.0)

        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None

        with self.state_lock:
            self.is_running = False
            self.safety_status = "OFFLINE"
            self.violations_count = 0
            self.hardhat_count = 0
            self._generate_offline_frame("MONITORING STOPPED")

    def stop(self):
        with self.action_lock:
            print("[SiteGuard] Stopping monitoring engine...")
            self._stop_unsafe()
            print("[SiteGuard] Monitoring stopped.")

    def set_source(self, source_id: str):
        with self.state_lock:
            self.source_id = source_id
            target = self._resolve_source(source_id)
            self.source_path = str(target)
            print(f"[SiteGuard] Selected source updated to: {self.source_id}")

    def _process_loop(self):
        cap = self.cap
        target = self._resolve_source(self.source_id)
        # Treat as file only if it is a local string path, not an IP/RTSP stream URL or webcam index
        is_file_source = isinstance(target, str) and not target.startswith(("http://", "https://", "rtsp://"))

        fps_counter = 0
        fps_start = time.time()

        while not self._stop_event.is_set():
            if cap is None or not cap.isOpened():
                break

            success, frame = cap.read()

            if not success:
                # Only loop if it is a recorded video file. Do not loop live network or camera streams.
                if is_file_source and not self._stop_event.is_set():
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    time.sleep(0.04)
                    continue
                else:
                    break

            fps_counter += 1
            now = time.time()
            if now - fps_start >= 1.0:
                with self.state_lock:
                    self.fps = round(fps_counter / (now - fps_start), 1)
                fps_counter = 0
                fps_start = now

            violations_in_frame = 0
            hardhats_in_frame = 0
            highest_violation_conf = 0.0
            last_detected_info = None

            if yolo_model is not None:
                try:
                    results = yolo_model(
                        frame,
                        conf=CONFIDENCE_THRESHOLD,
                        imgsz=IMAGE_SIZE,
                        verbose=False
                    )

                    for result in results:
                        for box in result.boxes:
                            class_id = int(box.cls[0])
                            confidence = float(box.conf[0])

                            # Only monitor Hardhat (0) and NO-Hardhat (2)
                            if class_id not in (0, 2):
                                continue

                            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())

                            if class_id == 2:
                                # NO-Hardhat violation
                                label = f"NO-Hardhat {confidence:.2f}"
                                color = (0, 0, 255)  # Red (BGR)
                                violations_in_frame += 1
                                if confidence > highest_violation_conf:
                                    highest_violation_conf = confidence
                                last_detected_info = {
                                    "class_id": 2,
                                    "class_name": "NO-Hardhat",
                                    "confidence": round(confidence, 2),
                                    "timestamp": datetime.now(timezone.utc).isoformat(),
                                }
                            else:
                                # Hardhat safe
                                label = f"Hardhat {confidence:.2f}"
                                color = (0, 200, 0)  # Green (BGR)
                                hardhats_in_frame += 1
                                if last_detected_info is None:
                                    last_detected_info = {
                                        "class_id": 0,
                                        "class_name": "Hardhat",
                                        "confidence": round(confidence, 2),
                                        "timestamp": datetime.now(timezone.utc).isoformat(),
                                    }

                            # Draw bounding box and label
                            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                            (w, h), _ = cv2.getTextSize(
                                label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2
                            )
                            cv2.rectangle(
                                frame,
                                (x1, max(y1 - 22, 0)),
                                (x1 + w + 8, max(y1, 22)),
                                color, -1
                            )
                            cv2.putText(
                                frame, label,
                                (x1 + 4, max(y1 - 6, 16)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                                (255, 255, 255), 2
                            )
                except Exception as e:
                    print(f"[SiteGuard] Inference error: {e}")

            # Update state metrics
            with self.state_lock:
                self.violations_count = violations_in_frame
                self.hardhat_count = hardhats_in_frame
                if last_detected_info:
                    self.latest_detection = last_detected_info

                if violations_in_frame > 0:
                    self.safety_status = "VIOLATION DETECTED"
                    self.total_violations_session += violations_in_frame
                elif hardhats_in_frame > 0:
                    self.safety_status = "SAFE"
                else:
                    self.safety_status = "NO DETECTIONS"

            # Firestore incident logging with cooldown
            now_mono = time.monotonic()
            if violations_in_frame > 0 and (now_mono - self.last_alert_time >= COOLDOWN_SECONDS):
                self.last_alert_time = now_mono
                firestore_executor.submit(
                    self._async_log_incident, highest_violation_conf, self.source_id
                )

            # Draw HUD overlay
            self._draw_hud(frame, violations_in_frame, hardhats_in_frame)

            # Encode frame to JPEG
            _, buffer = cv2.imencode(
                ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85]
            )
            with self.state_lock:
                self.latest_jpeg = buffer.tobytes()

            if is_file_source:
                time.sleep(0.033)
            else:
                time.sleep(0.01)

    def _draw_hud(self, frame, violations: int, hardhats: int):
        """Draw clean on-screen status overlay."""
        h, w, _ = frame.shape

        hud_bg = (24, 28, 38)
        cv2.rectangle(frame, (12, 12), (360, 52), hud_bg, -1)
        cv2.rectangle(frame, (12, 12), (360, 52), (55, 65, 85), 1)

        if violations > 0:
            status_text = f"VIOLATION: {violations} NO-HARDHAT"
            status_color = (0, 0, 255)
        elif hardhats > 0:
            status_text = f"SAFE: {hardhats} HARDHAT VERIFIED"
            status_color = (0, 210, 0)
        else:
            status_text = "SCANNING: NO DETECTIONS"
            status_color = (255, 180, 0)

        cv2.circle(frame, (28, 32), 6, status_color, -1)
        cv2.putText(
            frame, status_text,
            (42, 37), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255, 255, 255), 1
        )

        cv2.rectangle(frame, (12, h - 38), (340, h - 12), hud_bg, -1)
        with self.state_lock:
            fps_val = self.fps
            events_val = self.total_events_logged
        source_display = "Android Camera" if self.source_id == "android_camera" else self.source_id
        cv2.putText(
            frame, f"Source: {source_display} | Logged: {events_val} | {fps_val} FPS",
            (20, h - 22), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 205, 220), 1
        )

    def _async_log_incident(self, confidence: float, source_id: str):
        """Log detected violation to Firestore safety_events collection."""
        if not firebase_initialized or firebase_db is None:
            return

        try:
            source_type = "recorded_video" if "mp4" in source_id else "android_camera" if "android" in source_id else "webcam"
            video_name = "Android IP Camera (192.168.1.2:8080)" if "android" in source_id else os.path.basename(source_id)

            event = {
                "mode": "helmet_check",
                "event_type": "violation",
                "status": "NO-Hardhat",
                "confidence": round(float(confidence), 2),
                "source": source_type,
                "video": video_name,
                "timestamp": datetime.now(timezone.utc),
            }

            firebase_db.collection("safety_events").add(event)
            with self.state_lock:
                self.total_events_logged += 1
            print(f"[SiteGuard] Firestore violation logged! (Confidence: {confidence:.2f})")
        except Exception as e:
            print(f"[SiteGuard] Failed to write incident to Firestore: {e}")

    def get_status(self) -> Dict[str, Any]:
        with self.state_lock:
            return {
                "is_monitoring": self.is_running,
                "safety_status": self.safety_status,
                "source": self.source_id,
                "source_path": self.source_path,
                "violations_count": self.violations_count,
                "hardhat_count": self.hardhat_count,
                "total_violations_session": self.total_violations_session,
                "latest_detection": self.latest_detection,
                "total_events_logged": self.total_events_logged,
                "last_error": self.last_error,
                "fps": self.fps,
                "firebase_connected": firebase_initialized,
                "model_loaded": model_loaded,
            }


# Engine Singleton
engine = MonitorEngine()

# FastAPI Application
app = FastAPI(
    title="SiteGuard Live Safety Monitoring API",
    version="1.0.0",
    description="Live AI Computer Vision Safety Monitoring with YOLO and Firestore Integration",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StartMonitoringRequest(BaseModel):
    source: str = "helmet.mp4"


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "SiteGuard Monitoring API",
        "model_loaded": model_loaded,
        "firebase_connected": firebase_initialized,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/monitor/status")
def monitor_status():
    return engine.get_status()


@app.get("/api/monitor/sources")
def monitor_sources():
    sources = []
    if (VIDEOS_DIR / "helmet.mp4").exists():
        sources.append({
            "id": "helmet.mp4",
            "name": "helmet.mp4 (Compliant Scenario)",
            "type": "video",
            "description": "Recorded video showing workers wearing protective hardhats",
        })
    if (VIDEOS_DIR / "no_helmet.mp4").exists():
        sources.append({
            "id": "no_helmet.mp4",
            "name": "no_helmet.mp4 (Violation Scenario)",
            "type": "video",
            "description": "Recorded video demonstrating missing helmet safety violation",
        })

    # Android Phone Camera (IP Webcam)
    sources.append({
        "id": "android_camera",
        "name": "Android Camera (IP Webcam)",
        "type": "phone",
        "url": ANDROID_STREAM_URL,
        "description": f"Live wireless stream from Android phone ({ANDROID_STREAM_URL})",
    })

    # Local Built-in Webcam
    sources.append({
        "id": "webcam",
        "name": "Webcam (Built-in)",
        "type": "camera",
        "description": "Direct camera feed for physical testing and inspection",
    })

    return {"sources": sources, "current": engine.source_id}


@app.post("/api/monitor/start")
def start_monitoring(req: StartMonitoringRequest):
    if not model_loaded:
        raise HTTPException(status_code=500, detail="YOLO model is not loaded.")

    success = engine.start(req.source)
    if not success:
        raise HTTPException(
            status_code=400,
            detail=engine.last_error or f"Failed to start source: {req.source}",
        )

    return {
        "success": True,
        "message": f"Monitoring started with source '{req.source}'.",
        "status": engine.get_status(),
    }


@app.post("/api/monitor/stop")
def stop_monitoring():
    engine.stop()
    return {
        "success": True,
        "message": "Monitoring stopped successfully.",
        "status": engine.get_status(),
    }


class SetSourceRequest(BaseModel):
    source: str


@app.post("/api/monitor/source")
def set_monitor_source(req: SetSourceRequest):
    engine.set_source(req.source)
    return {
        "success": True,
        "message": f"Source updated to '{req.source}'.",
        "status": engine.get_status(),
    }


def frame_generator():
    """Stream MJPEG frames to browser."""
    while True:
        with engine.state_lock:
            frame_bytes = engine.latest_jpeg

        if frame_bytes:
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + frame_bytes + b"\r\n"
            )
        time.sleep(0.035)


@app.get("/api/monitor/stream")
def monitor_stream():
    return StreamingResponse(
        frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8001))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"[SiteGuard] Starting server on http://{host}:{port} ...")
    uvicorn.run(app, host=host, port=port)
