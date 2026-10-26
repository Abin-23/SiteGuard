
from ultralytics import YOLO

model = YOLO("models/best.pt")

print("\nSiteGuard Helmet Model")
print("----------------------")
print("Number of classes:", len(model.names))
print("\nAvailable classes:")

for class_id, class_name in model.names.items():
    print(f"{class_id}: {class_name}")
