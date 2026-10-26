from ultralytics import YOLO
import cv2
import torch

print("Python AI environment test")
print("OpenCV version:", cv2.__version__)
print("PyTorch version:", torch.__version__)

model = YOLO("yolo11n.pt")

print("YOLO model loaded successfully!")
print("Number of classes:", len(model.names))
print("SiteGuard AI setup is working.")
