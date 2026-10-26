
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timezone

KEY_PATH = "secrets/firebase-service-account.json"

try:
    # Initialize Firebase connection
    cred = credentials.Certificate(KEY_PATH)
    firebase_admin.initialize_app(cred)

    db = firestore.client()

    # Write one test event
    event = {
        "mode": "helmet_check",
        "event_type": "test",
        "status": "connection_successful",
        "source": "python_test",
        "timestamp": datetime.now(timezone.utc),
    }

    doc_ref = db.collection("safety_events").add(event)

    print("Firebase connection successful!")
    print("Test event ID:", doc_ref[1].id)

except Exception as e:
    print("Firebase connection failed.")
    print(type(e).__name__ + ":", e)
