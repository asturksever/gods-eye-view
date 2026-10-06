"""Project a frontal face photo onto a Rocketbox head texture."""
import sys, numpy as np, cv2
from scipy.spatial import Delaunay
sys.path.insert(0, __import__('os').path.dirname(__file__))
from lm import landmarks

PHOTO, MESH, RENDER, OUT = sys.argv[1:5]
N = 1024
d = np.load(MESH)
co, no, tris, tloops, tmat, uvs = (d[k] for k in ('co','no','tris','tloops','tmat','uvs'))
cx, cz, size, cam_y = d['cam']
head = np.isin(tmat, d['head_idx'])

def to_px(P):  # world -> render pixel (x right, y down); ortho along +Y
    return np.stack([(P[...,0]-cx)/size*N + N/2, N/2 - (P[...,2]-cz)/size*N], -1)

# --- landmarks
Lp, _ = landmarks(PHOTO); Lr, _ = landmarks(RENDER)
assert Lp is not None and Lr is not None, 'face not found'
Lp, Lr = Lp[:, :2], Lr[:, :2]
photo_u8 = cv2.cvtColor(cv2.imread(PHOTO, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
# Close the mouth: inpaint the inner-lip opening (teeth) from the lips around
# it, so the warp onto the model's closed mouth leaves no sliver of teeth.
INNER_LIP = [78,191,80,81,82,13,312,311,310,415,308,324,318,402,317,14,87,178,88,95]
hole = np.zeros(photo_u8.shape[:2], np.uint8)
cv2.fillPoly(hole, [np.round(Lp[INNER_LIP]).astype(np.int32)], 255)
hole = cv2.dilate(hole, np.ones((7,7), np.uint8))
photo_u8 = cv2.inpaint(photo_u8, hole, 9, cv2.INPAINT_TELEA)
photo = photo_u8.astype(np.float32)
# Person vs. the teal studio background: the background is the only blue-green
# region; beard, hair and skin are neutral or warm.
teal = (photo[..., 1] + photo[..., 2]) / 2 - photo[..., 0]
bgish = (teal > 12).astype(np.uint8)
bgish = cv2.morphologyEx(bgish, cv2.MORPH_OPEN, np.ones((5,5), np.uint8))
n, labels = cv2.connectedComponents(bgish)
edge = np.unique(np.r_[labels[0], labels[-1], labels[:, 0], labels[:, -1]])
background = np.isin(labels, edge[edge > 0])
person = (~background).astype(np.float32)

# Extend both landmark sets outward so the warp also covers forehead/hairline,
# the beard under the chin and the sideburns. Face oval indices (mediapipe).
OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]
def extend(L, scales):
    c = L[OVAL].mean(0); rings = [c + (L[OVAL]-c)*s for s in scales]
    return np.vstack([L] + rings)
SC = [1.15, 1.35]
Pp, Pr = extend(Lp, SC), extend(Lr, SC)
tri = Delaunay(Pr)

# --- warp the photo into the render frame (piecewise affine)
ys, xs = np.mgrid[0:N, 0:N]
q = np.stack([xs.ravel()+0.5, ys.ravel()+0.5], 1)
s = tri.find_simplex(q)
inside = s >= 0
T = tri.transform[s[inside]]
b = np.einsum('ijk,ik->ij', T[:, :2], q[inside] - T[:, 2])
bary = np.c_[b, 1 - b.sum(1)]
src = np.einsum('ij,ijk->ik', bary, Pp[tri.simplices[s[inside]]])
mapx = np.full(N*N, -1, np.float32); mapy = np.full(N*N, -1, np.float32)
mapx[inside], mapy[inside] = src[:, 0], src[:, 1]
warped = cv2.remap(photo, mapx.reshape(N,N), mapy.reshape(N,N), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
person_w = cv2.remap(person, mapx.reshape(N,N), mapy.reshape(N,N), cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
# Coverage mask: inner oval fully, fading out to the outer ring.
mask = np.zeros((N, N), np.float32)
c = Pr[len(Lr):len(Lr)+len(OVAL)]  # 1.15 ring
cv2.fillPoly(mask, [np.round(Lr[OVAL]).astype(np.int32)], 1.0)
mid = np.zeros_like(mask); cv2.fillPoly(mid, [np.round(c).astype(np.int32)], 1.0)
mask = np.maximum(mask, cv2.GaussianBlur(mid, (0,0), 6) * 0.999)
mask = cv2.GaussianBlur(mask, (0,0), 10) * cv2.GaussianBlur(cv2.erode(person_w, np.ones((9,9), np.uint8)), (0,0), 4)
cv2.imwrite(OUT + '_warped.png', cv2.cvtColor(np.clip(warped,0,255).astype(np.uint8), cv2.COLOR_RGB2BGR))
cv2.imwrite(OUT + '_mask.png', (mask*255).astype(np.uint8))
np.savez(OUT + '_lm.npz', Lp=Lp, Lr=Lr)
print('warped; mask coverage', mask.mean())
