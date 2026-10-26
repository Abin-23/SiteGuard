
from ultralytics import YOLO
import cv2
import os

MODEL_PATH = "models/best.pt"
VIDEO_PATH = "videos/no_helmet.mp4"

if not os.path.exists(VIDEO_PATH):
    raise FileNotFoundError(
        f"Video not found: {VIDEO_PATH}. "
        "Check the filename and extension."
    )

model = YOLO(MODEL_PATH)
cap = cv2.VideoCapture(VIDEO_PATH)

if not cap.isOpened():
    raise RuntimeError(f"Could not open video: {VIDEO_PATH}")

print("Testing:", VIDEO_PATH)
print("Press Q to quit.")

while True:
    success, frame = cap.read()

    if not success:
        break

    results = model(
    frame,
    conf=0.25,
    imgsz=960,
    verbose=False
)

    for result in results:
        for box in result.boxes:
            class_id = int(box.cls[0])
            confidence = float(box.conf[0])

            if class_id not in (0, 2):
                continue

            x1, y1, x2, y2 = map(
                int, box.xyxy[0].tolist()
            )

            if class_id == 0:
                label = f"Hardhat {confidence:.2f}"
                color = (0, 200, 0)
            else:
                label = f"NO-Hardhat {confidence:.2f}"
                color = (0, 0, 255)

            cv2.rectangle(
                frame, (x1, y1), (x2, y2), color, 2
            )
            cv2.putText(
                frame, label, (x1, max(y1 - 10, 20)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2
            )

    cv2.imshow("SiteGuard - Recorded Video Test", frame)

    if cv2.waitKey(25) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()
print("Video test completed.")
