
from ultralytics import YOLO
import cv2

# Load the pretrained YOLO model
model = YOLO("yolo11n.pt")

# Open the default webcam
cap = cv2.VideoCapture(0)

if not cap.isOpened():
    print("Camera could not be opened.")
    print("We can use a video file instead.")
    exit()

print("Camera started. Press Q to quit.")

while True:
    success, frame = cap.read()

    if not success:
        print("Could not read camera frame.")
        break

    # Detect objects in the frame
    results = model(frame, verbose=False)

    # Draw detection boxes
    annotated_frame = results[0].plot()

    cv2.imshow("SiteGuard - Person Detection", annotated_frame)

    # Press Q to exit
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()
