"""MediaPipe face landmarks (478 points, pixel coordinates)."""
import os, sys, numpy as np, mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
from PIL import Image
det = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=os.environ.get('FACE_LANDMARKER', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'face_landmarker.task'))), num_faces=1))
def landmarks(path):
    im = np.array(Image.open(path).convert('RGB'))
    r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=im))
    if not r.face_landmarks: return None, im.shape
    h, w = im.shape[:2]
    return np.array([[p.x*w, p.y*h, p.z*w] for p in r.face_landmarks[0]]), im.shape
if __name__ == '__main__':
    pts, shape = landmarks(sys.argv[1]); print(shape, None if pts is None else pts.shape)
    np.save(sys.argv[2], pts)
