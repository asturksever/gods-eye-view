"""Body: jacket+shirt -> the photo's dark knit, hands -> photo skin. Hair cards -> near black."""
import sys, numpy as np, cv2
from PIL import Image
BODY, OPAC, PHOTO, STATS, OUT = sys.argv[1:6]  # OPAC may be '-' (no hair cards)
st = np.load(STATS)
B = np.array(Image.open(BODY).convert('RGB')).astype(np.float32); W = B.shape[0]
P = cv2.cvtColor(cv2.imread(PHOTO), cv2.COLOR_BGR2RGB).astype(np.float32)
knit = np.vstack([P[950:1110, 30:250].reshape(-1, 3), P[950:1110, 860:1080].reshape(-1, 3)])
knit_col = np.median(knit, 0)
# The photo is graded teal; half-desaturate to a charcoal knit, a touch lifted.
knit_col = (0.5 * knit_col.mean() + 0.5 * knit_col) * 1.25; print('knit colour', knit_col)
yy, xx = np.mgrid[0:W, 0:W] / W
gray = B.mean(-1)
R, G, Bl = B[..., 0], B[..., 1], B[..., 2]
jeans = (Bl > R + 8) & (yy < 0.45)                      # blue denim
skin = (R > 120) & (R > G + 25) & (R > Bl + 45)          # arms, hands
shoes = (yy > 0.68) & (((xx > 0.20) & (xx < 0.36)) | ((xx > 0.62) & (xx < 0.80))) & ~skin
skin = cv2.morphologyEx(skin.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8)).astype(bool)
jeans = cv2.morphologyEx(jeans.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)).astype(bool)
top = ~(jeans | skin | shoes) & (gray > 3)
hands = skin
lum = gray / (np.median(gray[top & (gray > 20)]) + 1e-6)
rib = 1 + 0.12 * np.sin(2 * np.pi * np.arange(W) / 7.0)[None, :]  # vertical knit ribs
knit_rgb = knit_col * np.clip(lum, 0, 2.2)[..., None] ** 0.9 * rib[..., None]
out = B.copy()
out[top] = np.where(gray[top, None] > 4, knit_rgb[top], B[top])
def lab(x): return cv2.cvtColor(np.clip(x, 0, 255).astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
L = (lab(B) - st['mb']) * st['gain'] + st['mp']
skin = cv2.cvtColor(np.clip(L, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
out[hands] = skin[hands]
Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(OUT + '_body.png')
if OPAC == '-': sys.exit(0)
O = np.array(Image.open(OPAC).convert('RGBA')).astype(np.float32)
a = O[..., 3] > 10
g = O[..., :3].mean(-1, keepdims=True)
O[..., :3] = g * np.array([1.0, 0.93, 0.86]) * 0.75  # near-black, faintly warm
Image.fromarray(np.clip(O, 0, 255).astype(np.uint8)).save(OUT + '_opacity.png')
