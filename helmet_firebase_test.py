
from ultralytics import YOLO
import cv2
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timezone
import time
import os

MODEL_PATH = "models/best.pt"
VIDEO_PATH = "videos/helmet.mp4"
KEY_PATH = "secrets/firebase-service-account.json"

CONFIDENCE = 0.25
IMAGE_SIZE = 960
COOLDOWN_SECONDS = 10

# Initialize Firebase
cred = credentials.Certificate(KEY_PATH)
firebase_admin.initialize_app(cred)
db = firestore.client()

# Load AI model and video
model = YOLO(MODEL_PATH)

if not os.path.exists(VIDEO_PATH):
    raise FileNotFoundError(f"Video not found: {VIDEO_PATH}")

cap = cv2.VideoCapture(VIDEO_PATH)

if not cap.isOpened():
    raise RuntimeError("Could not open test video.")

last_alert_time = 0
total_events = 0

print("SiteGuard + Firebase started.")
print("Press Q to quit.")

try:
    while True:
        success, frame = cap.read()

        if not success:
            break

        results = model(
            frame,
            conf=CONFIDENCE,
            imgsz=IMAGE_SIZE,
            verbose=False
        )

        violation_detected = False
        violation_confidence = None

        for result in results:
            for box in result.boxes:
                class_id = int(box.cls[0])
                confidence = float(box.conf[0])

                if class_id not in (0, 2):
                    continue

                x1, y1, x2, y2 = map(
                    int, box.xyxy[0].tolist()
                )

                if class_id == 2:
                    label = f"NO-Hardhat {confidence:.2f}"
                    color = (0, 0, 255)
                    violation_detected = True
                    violation_confidence = confidence
                else:
                    label = f"Hardhat {confidence:.2f}"
                    color = (0, 200, 0)

                cv2.rectangle(
                    frame, (x1, y1), (x2, y2), color, 2
                )
                cv2.putText(
                    frame, label,
                    (x1, max(y1 - 10, 20)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6, color, 2
                )

        now = time.monotonic()

        if (
            violation_detected
            and now - last_alert_time >= COOLDOWN_SECONDS
        ):
            event = {
                "mode": "helmet_check",
                "event_type": "violation",
                "status": "NO-Hardhat",
                "confidence": violation_confidence,
                "source": "recorded_video",
                "video": os.path.basename(VIDEO_PATH),
                "timestamp": datetime.now(timezone.utc),
            }

            db.collection("safety_events").add(event)

            total_events += 1
            last_alert_time = now

            print(
                f"Violation logged! "
                f"Confidence: {violation_confidence:.2f}"
            )

        cv2.putText(
            frame,
            f"Firebase incidents: {total_events}",
            (15, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7, (255, 255, 255), 2
        )

        cv2.imshow("SiteGuard - Firebase Integration", frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

finally:
    cap.release()
    cv2.destroyAllWindows()

print(f"Total incidents uploaded: {total_events}")
