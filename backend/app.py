from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
from PIL import Image
import cv2
import os

from keras.models import load_model

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

pneumonia_model = load_model(os.path.join(BASE_DIR, "models", "pneumonia_model.h5"))
lung_model = load_model(os.path.join(BASE_DIR, "models", "lung_model.h5"))

IMG_SIZE = 224


def preprocess_image(img):
    img_resized = cv2.resize(img, (IMG_SIZE, IMG_SIZE))
    img_resized = img_resized / 255.0
    img_resized = np.expand_dims(img_resized, axis=0)
    return img_resized


def get_image_from_request():
    if "image" not in request.files:
        return None

    file = request.files["image"]

    try:
        img = np.array(Image.open(file).convert("RGB"))
        return img
    except:
        return None



@app.route("/predict/pneumonia", methods=["POST"])
def predict_pneumonia():

    img = get_image_from_request()

    if img is None:
        return jsonify({"error": "Invalid image"}), 400

    img = preprocess_image(img)

    prediction = pneumonia_model.predict(img)[0][0]

    if prediction > 0.5:
        label = "Pneumonia"
        confidence = float(prediction)
    else:
        label = "Normal"
        confidence = float(1 - prediction)

    return jsonify({
        "prediction": label,
        "confidence": confidence
    })


@app.route("/predict/lung", methods=["POST"])
def predict_lung():

    img = get_image_from_request()

    if img is None:
        return jsonify({"error": "Invalid image"}), 400

    img = preprocess_image(img)

    prediction = lung_model.predict(img)

    classes = ["BENIGN", "MALIGNANT", "NORMAL"]

    index = int(np.argmax(prediction))
    confidence = float(np.max(prediction))

    return jsonify({
        "prediction": classes[index],
        "confidence": confidence
    })


if __name__ == "__main__":
    app.run(debug=True)