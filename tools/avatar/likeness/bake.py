"""Bake the warped photo onto the head UV texture, extend the beard round the
jaw, match skin tone, darken hair. Writes <out>_head.png and <out>_stats.npz."""
import sys, numpy as np, cv2
from PIL import Image
MESH, FACE, HEAD_TEX, OUT, PHOTO = sys.argv[1:6]
N = 1024
d = np.load(MESH)
co, no, tris, tloops, tmat, uvs = (d[k] for k in ('co','no','tris','tloops','tmat','uvs'))
cx, cz, size, cam_y = d['cam']
H = np.array(Image.open(HEAD_TEX).convert('RGB')).astype(np.float32)
W = H.shape[0]
warped = cv2.cvtColor(cv2.imread(FACE + '_warped.png'), cv2.COLOR_BGR2RGB).astype(np.float32)
mask = cv2.imread(FACE + '_mask.png', 0).astype(np.float32) / 255
lm = np.load(FACE + '_lm.npz'); Lr, Lp = lm['Lr'], lm['Lp']
head = np.isin(tmat, d['head_idx'])
ht, hl = tris[head], tloops[head]

def px(P): return np.stack([(P[...,0]-cx)/size*N + N/2, N/2 - (P[...,2]-cz)/size*N], -1)
def world(xy): return np.stack([(xy[...,0]-N/2)/N*size + cx, cz - (xy[...,1]-N/2)/N*size], -1)  # X, Z

# --- depth buffer in the render frame (smaller Y = nearer the camera)
zbuf = np.full((N, N), np.inf, np.float32)
for t in tris:  # all triangles: collar/hair can hide skin
    P = co[t]; q = px(P)
    x0, y0 = np.floor(q.min(0)).astype(int); x1, y1 = np.ceil(q.max(0)).astype(int)
    x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, N-1), min(y1, N-1)
    if x1 < x0 or y1 < y0: continue
    gy, gx = np.mgrid[y0:y1+1, x0:x1+1]; g = np.stack([gx+0.5, gy+0.5], -1)
    T = np.array([q[0]-q[2], q[1]-q[2]]).T
    if abs(np.linalg.det(T)) < 1e-9: continue
    b = (g - q[2]) @ np.linalg.inv(T).T; b = np.concatenate([b, 1-b.sum(-1, keepdims=True)], -1)
    ins = (b >= -1e-4).all(-1)
    if not ins.any(): continue
    z = b @ P[:, 1]
    sub = zbuf[y0:y1+1, x0:x1+1]; upd = ins & (z < sub); sub[upd] = z[upd]

# --- rasterize head triangles in UV space
pos = np.zeros((W, W, 3), np.float32); nrm = np.zeros((W, W, 3), np.float32); cov = np.zeros((W, W), bool)
for t, l in zip(ht, hl):
    q = np.stack([uvs[l][:, 0]*W, (1-uvs[l][:, 1])*W], -1)
    x0, y0 = np.floor(q.min(0)).astype(int); x1, y1 = np.ceil(q.max(0)).astype(int)
    x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W-1), min(y1, W-1)
    if x1 < x0 or y1 < y0: continue
    gy, gx = np.mgrid[y0:y1+1, x0:x1+1]; g = np.stack([gx+0.5, gy+0.5], -1)
    T = np.array([q[0]-q[2], q[1]-q[2]]).T
    if abs(np.linalg.det(T)) < 1e-12: continue
    b = (g - q[2]) @ np.linalg.inv(T).T; b = np.concatenate([b, 1-b.sum(-1, keepdims=True)], -1)
    ins = (b >= -0.02).all(-1)  # slight overdraw closes seams
    if not ins.any(): continue
    pos[y0:y1+1, x0:x1+1][ins] = (b @ co[t])[ins]
    nrm[y0:y1+1, x0:x1+1][ins] = (b @ no[t])[ins]
    cov[y0:y1+1, x0:x1+1][ins] = True
nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True) + 1e-9

q = px(pos).astype(np.float32)
qi = np.clip(np.round(q).astype(int), 0, N-1)
visible = cov & (pos[..., 1] <= zbuf[qi[..., 1], qi[..., 0]] + 0.004)
facing = np.clip(-nrm[..., 1], 0, 1)
smooth = lambda e0, e1, x: np.clip((x - e0) / (e1 - e0), 0, 1) ** 2 * (3 - 2 * np.clip((x - e0) / (e1 - e0), 0, 1))
m = cv2.remap(mask, q[..., 0], q[..., 1], cv2.INTER_LINEAR, borderValue=0)
w = m * smooth(0.35, 0.7, facing) * visible
proj = cv2.remap(warped, q[..., 0], q[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

# --- skin tone: Lab mean/std transfer from base cheeks to photo cheeks
render = cv2.cvtColor(cv2.imread(MESH.replace('.npz', '_render.png')), cv2.COLOR_BGR2RGB).astype(np.float32)
def lab(x): return cv2.cvtColor(np.clip(x, 0, 255).astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
CHEEKS = [50, 280, 205, 425, 151, 9]
def samples(img, L):
    out = []
    for i in CHEEKS:
        x, y = np.round(L[i]).astype(int); out.append(img[y-12:y+12, x-12:x+12].reshape(-1, 3))
    return np.vstack(out)
sp, sb = samples(lab(warped), Lr), samples(lab(render), Lr)
mp_, sdp, mb, sdb = sp.mean(0), sp.std(0), sb.mean(0), sb.std(0)
gain = np.clip(sdp / (sdb + 1e-6), 0.7, 1.4)
def transfer(rgb):
    L = lab(rgb); L = (L - mb) * gain + mp_
    return cv2.cvtColor(np.clip(L, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
print('skin Lab base', mb.round(1), '-> photo', mp_.round(1))
base = transfer(H)
# Keep the eye/mouth-interior atlas (bottom-left) untouched.
XZ0 = world(Lr)
atlas = np.zeros((W, W), bool); atlas[int(W*0.57):, :int(W*0.37)] = True
atlas &= pos[..., 2] > XZ0[152, 1] - 0.01  # eyeballs/mouth sit above the chin; the neck island does not
base[atlas] = H[atlas]
w = w * ~atlas  # never project onto the eyeballs or mouth interior

# --- landmark heights in 3D (render landmarks -> world X,Z)
XZ = world(Lr)
z = lambda i: XZ[i, 1]
z_sub, z_eye, z_chin = z(2), (z(33) + z(263)) / 2, z(152)
z_tragus, z_jaw = (z(234) + z(454)) / 2, (z(132) + z(361)) / 2
hv = np.unique(ht); Yc = co[hv, 1].mean()
theta = np.abs(np.arctan2(pos[..., 0] - cx, -(pos[..., 1] - Yc)))
# Angle of the ears (tragus landmarks lifted to 3D) so the sideburns land there.
def lift(i):
    X, Zl = XZ[i]; near = hv[np.hypot(co[hv, 0] - X, co[hv, 2] - Zl) < 0.006]
    return np.arctan2(abs(X - cx), -(co[near, 1].min() - Yc))
theta_ear = (lift(234) + lift(454)) / 2
print('ear angle', np.degrees(theta_ear).round(1))
a = np.clip(theta / theta_ear, 0, 1)
z_top = (1 - a**2.5) * (z_sub - 0.012) + a**2.5 * (z_tragus + 0.012)
z_bot = (1 - a**1.2) * (z_chin - 0.05) + a**1.2 * (z_jaw - 0.035)
Z = pos[..., 2]; F = 0.005
# The photo's under-chin edge (beard shadow, background) must not run down the neck.
w = w * smooth(z_chin - 0.03, z_chin - 0.005, Z)
beard = smooth(z_top + F, z_top - F, Z) * smooth(z_bot - F, z_bot + F, Z) * smooth(theta_ear + 0.05, theta_ear - 0.08, theta) * cov

# --- hair: paint the base's scalp hair (any colour) the photo's near-black
Lb = lab(H)[..., 0]
hair = smooth(150, 115, Lb) * smooth(z_tragus - 0.02, z_tragus, Z) * cov * ~atlas
hair_col = np.array([24, 21, 19], np.float32)
hair_L = np.median(Lb[hair > 0.9]) if (hair > 0.9).any() else 60
shade = np.clip(Lb / hair_L, 0.4, 1.3) ** 0.8
base = base * (1 - 0.92 * hair[..., None]) + (hair_col * shade[..., None]) * 0.92 * hair[..., None]

# --- beard: procedural dense stubble in the photo's beard colour
bx, by = np.round(0.5 * Lp[17] + 0.5 * Lp[152]).astype(int)  # chin beard
P = cv2.cvtColor(cv2.imread(PHOTO), cv2.COLOR_BGR2RGB).astype(np.float32)
patch = P[by-40:by+40, bx-60:bx+60].reshape(-1, 3)
patch = patch[(patch[:, 1] + patch[:, 2]) / 2 - patch[:, 0] < 6]  # drop teal background
dark = patch[patch.mean(1) < np.percentile(patch.mean(1), 8)]
beard_col = np.median(dark, 0) * 0.75
rng = np.random.default_rng(7)
noise = cv2.GaussianBlur(rng.standard_normal((W, W)).astype(np.float32), (0, 0), sigmaX=1.1, sigmaY=3.5)
noise = np.clip(0.5 + noise / (3 * noise.std()), 0, 1)
beard = beard * ~atlas
density = beard * (0.85 + 0.15 * noise)
strands = beard_col * (0.35 + 1.3 * noise[..., None])
print('beard colour', beard_col.round(1))
out = base * (1 - 0.95 * density[..., None]) + strands * 0.95 * density[..., None]
out = out * (1 - w[..., None]) + proj * w[..., None]
# --- irises -> the photo's dark brown (eyeball island, bottom-left atlas)
x0, x1, y0, y1 = int(W*0.17), int(W*0.34), int(W*0.84), int(W*0.995)
E = lab(out[y0:y1, x0:x1])
bright = E[..., 0] > 150  # sclera: the iris sits at its centre
cy, cx_ = np.argwhere(bright).mean(0)
yy, xx = np.mgrid[y0:y1, x0:x1]
r = np.hypot(yy - (y0 + cy), xx - (x0 + cx_))
iris = (r < W * 0.0195) & (E[..., 0] < 200)
E[..., 0] = np.where(iris, E[..., 0] * 0.5, E[..., 0])
E[..., 1] = np.where(iris, 137, E[..., 1]); E[..., 2] = np.where(iris, 145, E[..., 2])
out[y0:y1, x0:x1] = cv2.cvtColor(np.clip(E, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)
cv2.imwrite(OUT + '_head.png', cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
np.savez(OUT + '_stats.npz', mb=mb, mp=mp_, gain=gain, hair_col=hair_col)
print('done', w.max(), beard.mean())
