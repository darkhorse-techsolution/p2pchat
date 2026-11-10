#!/usr/bin/env python3
# P2P Chat input helper for Linux (X11): posts the mouse and keyboard events of a screen-share
# remote control through the XTest extension. No dependencies beyond libX11 + libXtst (both in
# the deb's Depends) and $DISPLAY. Wayland sessions are refused before this runs.
#
# Protocol (one command per line on stdin, numbers are screen pixels, see main/input.js):
#   m X Y            move the pointer
#   d B X Y          button B (0 left, 1 right, 2 middle) down at X Y
#   u B X Y          button up
#   w DX DY X Y      wheel, DX/DY in pixels (positive = content scrolls right / down)
#   k SYM 1|0        key down / up, SYM = X11 keysym
#   r                release everything held
# "ready" and errors go to stderr. Everything held is released at "r" and at end of input.
import sys
import ctypes
import ctypes.util
from ctypes import c_void_p, c_int, c_uint, c_ulong, c_char_p, c_ubyte

try:
    X = ctypes.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
    T = ctypes.CDLL(ctypes.util.find_library('Xtst') or 'libXtst.so.6')
except OSError as e:
    print(f'err libraries: {e}', file=sys.stderr, flush=True)
    sys.exit(2)
X.XOpenDisplay.restype = c_void_p
X.XOpenDisplay.argtypes = [c_char_p]
X.XCloseDisplay.argtypes = [c_void_p]
X.XFlush.argtypes = [c_void_p]
X.XKeysymToKeycode.argtypes = [c_void_p, c_ulong]
X.XKeysymToKeycode.restype = c_ubyte
T.XTestFakeMotionEvent.argtypes = [c_void_p, c_int, c_int, c_int, c_ulong]
T.XTestFakeButtonEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
T.XTestFakeKeyEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]

dpy = X.XOpenDisplay(None)
if not dpy:
    print('err cannot open the X display', file=sys.stderr, flush=True)
    sys.exit(2)

BTN = {0: 1, 1: 3, 2: 2}          # DOM button -> X button
WHEEL_PX = 40                     # pixels of scroll per wheel click
held_keys = set()
held_buttons = set()
acc = [0.0, 0.0]


def flush():
    X.XFlush(dpy)


def move(x, y):
    T.XTestFakeMotionEvent(dpy, -1, x, y, 0)
    flush()


def button(b, down, x, y):
    T.XTestFakeMotionEvent(dpy, -1, x, y, 0)
    T.XTestFakeButtonEvent(dpy, BTN[b], 1 if down else 0, 0)
    flush()
    (held_buttons.add if down else held_buttons.discard)(b)


def wheel(dx, dy, x, y):
    T.XTestFakeMotionEvent(dpy, -1, x, y, 0)
    for i, d in ((0, dx), (1, dy)):
        acc[i] += d
        while abs(acc[i]) >= WHEEL_PX:
            btn = (7 if acc[i] > 0 else 6) if i == 0 else (5 if acc[i] > 0 else 4)
            T.XTestFakeButtonEvent(dpy, btn, 1, 0)
            T.XTestFakeButtonEvent(dpy, btn, 0, 0)
            acc[i] -= WHEEL_PX if acc[i] > 0 else -WHEEL_PX
    flush()


def key(sym, down):
    kc = X.XKeysymToKeycode(dpy, sym)
    if not kc:
        return
    T.XTestFakeKeyEvent(dpy, kc, 1 if down else 0, 0)
    flush()
    (held_keys.add if down else held_keys.discard)(kc)


def reset():
    for kc in list(held_keys):
        T.XTestFakeKeyEvent(dpy, kc, 0, 0)
    for b in list(held_buttons):
        T.XTestFakeButtonEvent(dpy, BTN[b], 0, 0)
    held_keys.clear()
    held_buttons.clear()
    acc[0] = acc[1] = 0.0
    flush()


print('ready', file=sys.stderr, flush=True)
for line in sys.stdin:
    p = line.split()
    if not p:
        continue
    try:
        c, n = p[0], [int(float(v)) for v in p[1:]]
        if c == 'm' and len(n) >= 2:
            move(n[0], n[1])
        elif c in ('d', 'u') and len(n) >= 3 and n[0] in BTN:
            button(n[0], c == 'd', n[1], n[2])
        elif c == 'w' and len(n) >= 4:
            wheel(n[0], n[1], n[2], n[3])
        elif c == 'k' and len(n) >= 2:
            key(n[0], n[1] != 0)
        elif c == 'r':
            reset()
    except Exception as e:  # a bad line must not take the helper down
        print(f'err {e}', file=sys.stderr, flush=True)
reset()
X.XCloseDisplay(dpy)
