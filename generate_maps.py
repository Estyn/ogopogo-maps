"""Generate Ironman-style race course maps (PDF + HTML) for the Ogopogo Extreme
and Ogopogo 3500 triathlons.

Outputs are written to ./docs/. Per-course PDFs are merged into one PDF per
race (extreme / 3500) containing: swim, bike, run.
"""
from __future__ import annotations

import json
import math
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

import contextily as cx
import folium
import gpxpy
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import patches
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch
from matplotlib.transforms import Affine2D
from pypdf import PdfWriter, PdfReader

# ---------------------------------------------------------------------------
# Style — Ogopogo Extreme brand palette (sampled from logo)
# ---------------------------------------------------------------------------
BRAND_GREEN = "#1F5C2E"           # mountain green from logo
BRAND_GREEN_DARK = "#0F3F1F"
BRAND_RED = "#C00000"             # logo red
BRAND_CREAM = "#F0E0C0"           # warm cream from logo
BRAND_BLACK = "#0A0A0A"

ROUTE_COLOR = BRAND_RED
HEADER_COLOR = BRAND_GREEN_DARK    # deep green header (Ogopogo, not Ironman black)
ACCENT_COLOR = BRAND_CREAM         # cream subtitle text
KM_MARKER_FILL = BRAND_GREEN       # green pill markers
KM_MARKER_TEXT = "#FFFFFF"
LEGEND_BG = "#FFFFFF"
LEGEND_BORDER = BRAND_RED
START_COLOR = BRAND_GREEN          # green start (brand)
FINISH_COLOR = BRAND_BLACK
TRANSITION_COLOR = "#1B4F8A"
LOGO_PATH = Path(__file__).parent / "assets" / "logo.png"

# Two basemap styles — selected at runtime
BASEMAP_STYLES = {
    "light": {
        "base": cx.providers.CartoDB.Voyager,
        "overlay": None,
        # Tweaks applied when this style is active
        "route_color": "#C00000",
        "route_lw": 3.0,
        "route_outline": None,
        "km_text_color": "#FFFFFF",
    },
    "satellite": {
        # Esri imagery + transparent label overlay = hybrid (roads visible
        # in the imagery itself; CartoDB label tiles add road/place names).
        "base": cx.providers.Esri.WorldImagery,
        "overlay": cx.providers.CartoDB.VoyagerOnlyLabels,
        # On dark imagery the route needs a white halo to stay readable
        "route_color": "#FF1F1F",
        "route_lw": 3.5,
        "route_outline": "#FFFFFF",
        "km_text_color": "#FFFFFF",
    },
}
# Active style — overridden by main() per pass
ACTIVE_STYLE = "light"
def _style():
    return BASEMAP_STYLES[ACTIVE_STYLE]


@dataclass
class Course:
    key: str
    race: str            # "extreme" or "3500"
    discipline: str      # "swim" | "bike" | "run"
    title: str           # e.g. "BIKE COURSE"
    gpx: Path | None     # None for swim (synthetic)
    distance_label: str  # e.g. "183 KILOMETERS / 1 LAP"
    location: str = "PENTICTON, BRITISH COLUMBIA, CANADA"
    legend_pos: str = "bl"  # "br" (bottom-right) or "bl" (bottom-left)


# ---------------------------------------------------------------------------
# GPX parsing
# ---------------------------------------------------------------------------
def parse_gpx(path: Path):
    """Return arrays of lat, lon, elevation, cumulative distance (km)."""
    with open(path) as f:
        gpx = gpxpy.parse(f)
    lats, lons, eles = [], [], []
    for track in gpx.tracks:
        for seg in track.segments:
            for p in seg.points:
                lats.append(p.latitude)
                lons.append(p.longitude)
                eles.append(p.elevation if p.elevation is not None else 0.0)
    lats = np.asarray(lats)
    lons = np.asarray(lons)
    eles = np.asarray(eles)

    # Cumulative haversine distance
    R = 6371.0
    lat_r = np.radians(lats)
    lon_r = np.radians(lons)
    dlat = np.diff(lat_r)
    dlon = np.diff(lon_r)
    a = np.sin(dlat / 2) ** 2 + np.cos(lat_r[:-1]) * np.cos(lat_r[1:]) * np.sin(dlon / 2) ** 2
    seg_km = 2 * R * np.arcsin(np.sqrt(a))
    dist = np.concatenate([[0.0], np.cumsum(seg_km)])

    return lats, lons, eles, dist


def webmerc(lon, lat):
    """Project to Web Mercator (matches the basemap)."""
    R = 6378137.0
    x = np.radians(lon) * R
    y = np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * R
    return x, y


def _swim_rectangle(beach_lat, beach_lon, long_m, short_m, rotation_deg=12):
    """Build a rotated swim rectangle anchored at the start (NE) corner.

    Course path (counter-clockwise) before rotation:
      NE (start, on beach) -> SE (into lake) -> SW -> NW (back to beach) -> NE
    The rectangle is rotated counter-clockwise by `rotation_deg` so the long
    edge aligns with the actual shoreline (which runs slightly NW-SE).
    Returns parallel lists of lons, lats (length 5, closed polygon).
    """
    theta = math.radians(rotation_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    local = [
        (0.0, 0.0),                   # NE, start
        (0.0, -short_m),              # SE
        (-long_m, -short_m),          # SW
        (-long_m, 0.0),               # NW
        (0.0, 0.0),                   # close
    ]
    rotated = [
        (x * cos_t - y * sin_t, x * sin_t + y * cos_t) for x, y in local
    ]
    deg_per_m_lat = 1.0 / 110540.0
    deg_per_m_lon = 1.0 / (111320.0 * math.cos(math.radians(beach_lat)))
    lons = [beach_lon + dx * deg_per_m_lon for dx, _ in rotated]
    lats = [beach_lat + dy * deg_per_m_lat for _, dy in rotated]
    return lons, lats


# ---------------------------------------------------------------------------
# Helpers — direction arrows, KM markers, START/FINISH/TRANSITION glyphs
# ---------------------------------------------------------------------------
def add_direction_arrows(ax, xs, ys, every_km, dist_km, color=ROUTE_COLOR):
    """Place subtle direction arrowheads along the route every `every_km`."""
    targets = np.arange(every_km / 2, dist_km[-1], every_km)
    for t in targets:
        i = int(np.searchsorted(dist_km, t))
        if i <= 0 or i >= len(xs) - 1:
            continue
        x0, y0 = xs[i - 1], ys[i - 1]
        x1, y1 = xs[i + 1], ys[i + 1]
        # very short arrow — head only — to indicate direction
        arrow = FancyArrowPatch(
            (x0, y0), (x1, y1),
            arrowstyle="-|>", mutation_scale=11,
            color=color, linewidth=0, zorder=4,
        )
        ax.add_patch(arrow)


def add_km_markers(ax, xs, ys, dist_km, every=5):
    """Numbered green pill markers every `every` kilometers, like Ironman's."""
    total = dist_km[-1]
    targets = np.arange(every, total, every)
    placed = []
    for t in targets:
        i = int(np.searchsorted(dist_km, t))
        if i >= len(xs):
            continue
        x, y = xs[i], ys[i]
        # crude collision avoidance: skip if too close to an existing marker
        if any(math.hypot(x - px, y - py) < 600 for px, py in placed):
            continue
        placed.append((x, y))

        label = f"{int(round(t))}"
        # pill shape (small)
        ax.scatter([x], [y], s=190, marker="o",
                   facecolor=KM_MARKER_FILL, edgecolor="white",
                   linewidth=1.2, zorder=6)
        ax.text(x, y, label, color=KM_MARKER_TEXT,
                fontsize=7.5, fontweight="bold",
                ha="center", va="center", zorder=7)


def add_endpoint(ax, x, y, kind):
    """START / FINISH / TRANSITION glyphs."""
    if kind == "START":
        ax.scatter([x], [y], s=520, marker="s", facecolor=START_COLOR,
                   edgecolor="white", linewidth=2.0, zorder=8)
        ax.text(x, y, "S", color="white", fontsize=11, fontweight="bold",
                ha="center", va="center", zorder=9)
    elif kind == "FINISH":
        ax.scatter([x], [y], s=520, marker="s", facecolor=FINISH_COLOR,
                   edgecolor="white", linewidth=2.0, zorder=8)
        ax.text(x, y, "F", color="white", fontsize=11, fontweight="bold",
                ha="center", va="center", zorder=9)
    elif kind == "START_FINISH":
        # Combined glyph — checkered-flag style, drawn in axes-pixel space so it
        # scales to a consistent visible size regardless of map extent.
        from matplotlib.offsetbox import AnnotationBbox, TextArea, HPacker, DrawingArea
        from matplotlib.patches import Rectangle as _Rect
        from matplotlib.offsetbox import OffsetImage
        # Simple approach: two scatter squares side-by-side using display offsets
        ann = ax.annotate(
            "", xy=(x, y), xycoords="data",
            xytext=(0, 0), textcoords="offset points",
            zorder=8,
        )
        # Use two text annotations side-by-side, each in its own bbox
        ax.annotate(
            " S ", xy=(x, y), xycoords="data",
            xytext=(-8, 0), textcoords="offset points",
            ha="center", va="center",
            fontsize=10, fontweight="bold", color="white",
            bbox=dict(boxstyle="square,pad=0.35", fc=START_COLOR,
                      ec="white", lw=1.5),
            zorder=9,
        )
        ax.annotate(
            " F ", xy=(x, y), xycoords="data",
            xytext=(8, 0), textcoords="offset points",
            ha="center", va="center",
            fontsize=10, fontweight="bold", color="white",
            bbox=dict(boxstyle="square,pad=0.35", fc=FINISH_COLOR,
                      ec="white", lw=1.5),
            zorder=9,
        )
    elif kind == "T":
        ax.scatter([x], [y], s=520, marker="s", facecolor=TRANSITION_COLOR,
                   edgecolor="white", linewidth=2.0, zorder=8)
        ax.text(x, y, "T", color="white", fontsize=11, fontweight="bold",
                ha="center", va="center", zorder=9)


def draw_north_arrow(ax):
    """North arrow in the upper-left corner of the axes."""
    ax.annotate(
        "N",
        xy=(0.025, 0.955), xycoords="axes fraction",
        ha="center", va="center",
        fontsize=11, fontweight="bold", color="white",
        bbox=dict(boxstyle="circle,pad=0.45", fc=ROUTE_COLOR, ec="white", lw=1.5),
        zorder=20,
    )
    ax.annotate(
        "", xy=(0.025, 0.985), xycoords="axes fraction",
        xytext=(0.025, 0.93),
        arrowprops=dict(arrowstyle="-|>", color=ROUTE_COLOR, lw=2),
        zorder=19,
    )


def draw_legend(ax, position="br"):
    """Ironman-style legend, positioned in the named corner."""
    legend_items = [
        ("S", START_COLOR, "START LINE"),
        ("F", FINISH_COLOR, "FINISH LINE"),
        ("T", TRANSITION_COLOR, "TRANSITION AREA"),
        ("5", KM_MARKER_FILL, "KILOMETER MARKERS"),
    ]
    n = len(legend_items)
    w, h = 0.24, 0.05 + 0.045 * n
    x0 = 0.74 if position == "br" else 0.02
    y0 = 0.02
    ax.add_patch(plt.Rectangle((x0, y0), w, h, transform=ax.transAxes,
                               fc=LEGEND_BG, ec=LEGEND_BORDER, lw=2, zorder=15))
    # Header bar
    ax.add_patch(plt.Rectangle((x0, y0 + h - 0.035), w, 0.035, transform=ax.transAxes,
                               fc=LEGEND_BORDER, ec=LEGEND_BORDER, zorder=16))
    ax.text(x0 + w / 2, y0 + h - 0.0175, "LEGEND", transform=ax.transAxes,
            color="white", fontsize=9, fontweight="bold",
            ha="center", va="center", zorder=17)
    for i, (sym, color, label) in enumerate(legend_items):
        yy = y0 + h - 0.06 - i * 0.045
        ax.scatter([x0 + 0.025], [yy], transform=ax.transAxes,
                   s=180, marker="s", facecolor=color, edgecolor="white",
                   linewidth=1.2, zorder=17, clip_on=False)
        ax.text(x0 + 0.025, yy, sym, transform=ax.transAxes,
                color="white", fontsize=8, fontweight="bold",
                ha="center", va="center", zorder=18)
        ax.text(x0 + 0.055, yy, label, transform=ax.transAxes,
                color="#222", fontsize=8.5, ha="left", va="center", zorder=18)


# ---------------------------------------------------------------------------
# Header bar
# ---------------------------------------------------------------------------
def draw_header(fig, race_name: str, course_title: str, distance_label: str,
                location: str):
    """Top header strip with logo + race + course title."""
    band = fig.add_axes([0, 0.93, 1, 0.07])
    band.set_xticks([]); band.set_yticks([])
    band.set_facecolor(HEADER_COLOR)
    for s in band.spines.values():
        s.set_visible(False)

    # Logo (left side) — embedded as figimage so it doesn't distort
    if LOGO_PATH.exists():
        from PIL import Image
        logo = Image.open(LOGO_PATH).convert("RGBA")
        # Scale to header height
        target_h_px = int(fig.get_figheight() * 200 * 0.06)  # ~6% of fig
        ratio = target_h_px / logo.height
        new_size = (int(logo.width * ratio), target_h_px)
        logo = logo.resize(new_size, Image.LANCZOS)
        # Place at left side of header — figimage uses pixel coords from bottom-left
        fig_w_px = int(fig.get_figwidth() * 200)
        fig_h_px = int(fig.get_figheight() * 200)
        # Header band sits at y=0.93..1.0, center logo vertically in it
        band_bottom_px = int(0.93 * fig_h_px)
        band_top_px = fig_h_px
        y_center = (band_bottom_px + band_top_px) // 2
        y_origin = y_center - logo.height // 2
        fig.figimage(np.asarray(logo), xo=24, yo=y_origin, zorder=10)
        text_x = 0.10  # shift text right to clear logo
    else:
        text_x = 0.015

    band.text(text_x, 0.62, race_name,
              color="white", fontsize=18, fontweight="bold",
              ha="left", va="center")
    band.text(text_x, 0.24, "T R I A T H L O N   •   P E N T I C T O N ,   B C",
              color=ACCENT_COLOR, fontsize=8.5, fontweight="bold",
              ha="left", va="center")

    band.text(0.985, 0.72, course_title,
              color="white", fontsize=15, fontweight="bold",
              ha="right", va="center")
    band.text(0.985, 0.40, distance_label,
              color="white", fontsize=10, ha="right", va="center")
    band.text(0.985, 0.12, location,
              color=BRAND_CREAM, fontsize=8.5, ha="right", va="center")

    # Thin red accent line below header
    accent = fig.add_axes([0, 0.928, 1, 0.003])
    accent.set_xticks([]); accent.set_yticks([])
    accent.set_facecolor(BRAND_RED)
    for s in accent.spines.values():
        s.set_visible(False)


def draw_footer(fig, text="© Ogopogo Extreme Triathlon. All rights reserved."):
    foot = fig.add_axes([0, 0, 1, 0.02])
    foot.set_xticks([]); foot.set_yticks([])
    foot.set_facecolor("#eeeeee")
    for s in foot.spines.values():
        s.set_visible(False)
    foot.text(0.015, 0.5, text, color="#666", fontsize=7,
              ha="left", va="center")


# ---------------------------------------------------------------------------
# Map page
# ---------------------------------------------------------------------------
def render_course_map(course: Course, out_pdf: Path):
    """Render one course as an 8.5x11 PDF page (map + elevation)."""
    fig = plt.figure(figsize=(8.5, 11))

    # header / footer
    draw_header(fig,
                race_name=("OGOPOGO EXTREME" if course.race == "extreme"
                           else "OGOPOGO 3500"),
                course_title=course.title,
                distance_label=course.distance_label,
                location=course.location)
    draw_footer(fig)

    if course.discipline == "swim":
        _render_swim(fig, course)
    else:
        _render_gpx_course(fig, course)

    fig.savefig(out_pdf, format="pdf", dpi=200, bbox_inches=None)
    plt.close(fig)


def _render_gpx_course(fig, course: Course):
    lats, lons, eles, dist_km = parse_gpx(course.gpx)
    xs, ys = webmerc(lons, lats)

    # Map axes — leave room for header (top) and elevation (bottom)
    ax = fig.add_axes([0.04, 0.22, 0.92, 0.70])

    # Plot route (with optional white halo for visibility on dark imagery)
    style = _style()
    if style["route_outline"]:
        ax.plot(xs, ys, color=style["route_outline"],
                linewidth=style["route_lw"] + 2.2,
                solid_capstyle="round", zorder=2)
    ax.plot(xs, ys, color=style["route_color"],
            linewidth=style["route_lw"], solid_capstyle="round", zorder=3)

    # Pad bounds so the basemap has a comfortable margin
    xmin, xmax = xs.min(), xs.max()
    ymin, ymax = ys.min(), ys.max()
    span = max(xmax - xmin, ymax - ymin)
    pad = span * 0.08
    cx_mid = (xmin + xmax) / 2
    cy_mid = (ymin + ymax) / 2
    half = span / 2 + pad
    ax.set_xlim(cx_mid - half, cx_mid + half)
    ax.set_ylim(cy_mid - half, cy_mid + half)
    ax.set_aspect("equal")
    ax.set_xticks([]); ax.set_yticks([])
    for s in ax.spines.values():
        s.set_edgecolor("#cccccc")

    # Basemap (style-dependent)
    try:
        cx.add_basemap(ax, source=style["base"], crs="EPSG:3857",
                       attribution_size=5)
        if style["overlay"] is not None:
            cx.add_basemap(ax, source=style["overlay"], crs="EPSG:3857",
                           attribution=False, attribution_size=0)
    except Exception as e:
        print(f"  basemap failed ({e}); continuing without basemap")

    # Direction arrows, km markers, start/finish
    every_km = 4 if dist_km[-1] < 30 else 8 if dist_km[-1] < 100 else 12
    add_direction_arrows(ax, xs, ys, every_km, dist_km)
    add_km_markers(ax, xs, ys, dist_km,
                   every=5 if dist_km[-1] < 100 else 10)

    # If start and finish are within ~300 m, treat as a loop and show one combined glyph
    start_end_dist_m = math.hypot(xs[0] - xs[-1], ys[0] - ys[-1])
    if start_end_dist_m < 300:
        add_endpoint(ax, xs[0], ys[0], "START_FINISH")
    else:
        add_endpoint(ax, xs[0], ys[0], "START")
        add_endpoint(ax, xs[-1], ys[-1], "FINISH")

    # Decorations
    draw_north_arrow(ax)
    draw_legend(ax, position=course.legend_pos)

    # Elevation profile
    ele_ax = fig.add_axes([0.08, 0.06, 0.84, 0.12])
    ele_ax.fill_between(dist_km, eles, eles.min(), color=ROUTE_COLOR, alpha=0.18)
    ele_ax.plot(dist_km, eles, color=ROUTE_COLOR, linewidth=1.5)
    ele_ax.set_xlim(0, dist_km[-1])
    ele_ax.set_ylim(eles.min() - 30, eles.max() + 60)
    ele_ax.set_xlabel("KILOMETERS", fontsize=8, color="#444",
                      labelpad=2, fontweight="bold")
    ele_ax.set_ylabel("ELEVATION (m)", fontsize=8, color="#444",
                      fontweight="bold")
    ele_ax.tick_params(axis="both", labelsize=7, colors="#666")
    for s in ele_ax.spines.values():
        s.set_edgecolor("#cccccc")
    ele_ax.grid(True, linestyle=":", color="#cccccc", linewidth=0.5)

    # Stats line above elevation
    gain = float(np.sum(np.clip(np.diff(eles), 0, None)))
    stats = (f"DISTANCE: {dist_km[-1]:.1f} km    "
             f"ELEVATION GAIN: {gain:,.0f} m    "
             f"START ELEV: {eles[0]:.0f} m    "
             f"FINISH ELEV: {eles[-1]:.0f} m")
    fig.text(0.08, 0.195, stats, fontsize=9, color="#222",
             fontweight="bold", ha="left", va="bottom")


def _render_swim(fig, course: Course):
    """Skaha Beach swim — rectangle starting at the beach, extending into lake."""
    # Skaha Beach, Penticton (north shore of Skaha Lake — east end of the
    # public beach where the shoreline runs roughly east–west).
    beach_lat, beach_lon = 49.4527, -119.5821
    # Long side runs roughly along the shoreline (rotated to match Skaha
    # Beach's actual NW–SE orientation); short side reaches into the lake.
    if course.race == "extreme":
        rect_long_m, rect_short_m = 750, 200    # 2 laps ≈ 3.8 km
        laps = 2
    else:
        rect_long_m, rect_short_m = 750, 200    # 1 lap ≈ 1.9 km
        laps = 1
    rect_lons, rect_lats = _swim_rectangle(beach_lat, beach_lon,
                                           rect_long_m, rect_short_m,
                                           rotation_deg=12)
    xs, ys = webmerc(np.asarray(rect_lons), np.asarray(rect_lats))

    ax = fig.add_axes([0.04, 0.22, 0.92, 0.70])
    style = _style()

    # No course lines drawn — the swim is provided as a blank basemap so the
    # course can be added by hand. Bounds are still framed around the
    # intended swim area off Skaha Beach.
    xmin, xmax = xs.min() - 700, xs.max() + 700
    ymin, ymax = ys.min() - 700, ys.max() + 700
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)
    ax.set_aspect("equal")
    ax.set_xticks([]); ax.set_yticks([])

    try:
        cx.add_basemap(ax, source=style["base"], crs="EPSG:3857",
                       attribution_size=5)
        if style["overlay"] is not None:
            cx.add_basemap(ax, source=style["overlay"], crs="EPSG:3857",
                           attribution=False, attribution_size=0)
    except Exception as e:
        print(f"  basemap failed ({e}); continuing without basemap")

    draw_north_arrow(ax)

    fig.text(0.08, 0.13,
             f"DISTANCE: {course.distance_label}    LAPS: {laps}    "
             f"LOCATION: Skaha Beach, Penticton",
             fontsize=10, color="#222", fontweight="bold")
    fig.text(0.08, 0.10,
             "Open-water swim at Skaha Beach. Course to be marked on this map "
             "by hand.",
             fontsize=9, color="#444")


# ---------------------------------------------------------------------------
# Folium (interactive HTML)
# ---------------------------------------------------------------------------
def render_course_html(course: Course, out_html: Path):
    if course.discipline == "swim":
        center = (49.4500, -119.5821)
        zoom = 15
    else:
        lats, lons, eles, dist = parse_gpx(course.gpx)
        center = (float(lats.mean()), float(lons.mean()))
        zoom = 11 if dist[-1] > 100 else 12

    fmap = folium.Map(location=center, zoom_start=zoom,
                      tiles="CartoDB positron")
    title = (f"{'Ogopogo Extreme' if course.race == 'extreme' else 'Ogopogo 3500'}"
             f" — {course.title.title()}")
    folium.map.Marker(
        center,
        icon=folium.DivIcon(html=(
            f"<div style='font-family:Arial;font-weight:bold;"
            f"font-size:18px;color:white;background:{HEADER_COLOR};"
            f"padding:8px 14px;border-radius:6px;border:2px solid {ROUTE_COLOR};"
            f"box-shadow:0 2px 6px rgba(0,0,0,.25);white-space:nowrap;"
            f"transform:translate(-50%,-180%);'>"
            f"{title}<br><span style='color:{ACCENT_COLOR};font-size:11px;'>"
            f"{course.distance_label}</span></div>"
        )),
    ).add_to(fmap)

    if course.discipline == "swim":
        # Blank swim map — no course lines or markers; course to be added by hand.
        pass
    else:
        coords = list(zip(lats.tolist(), lons.tolist()))
        folium.PolyLine(coords, color=ROUTE_COLOR, weight=5,
                        opacity=0.9, tooltip=course.title).add_to(fmap)
        folium.Marker((float(lats[0]), float(lons[0])),
                      tooltip="START",
                      icon=folium.Icon(color="green", icon="play",
                                       prefix="fa")).add_to(fmap)
        folium.Marker((float(lats[-1]), float(lons[-1])),
                      tooltip="FINISH",
                      icon=folium.Icon(color="black", icon="flag-checkered",
                                       prefix="fa")).add_to(fmap)
        # KM markers
        every = 5 if dist[-1] < 100 else 10
        for t in np.arange(every, dist[-1], every):
            i = int(np.searchsorted(dist, t))
            if i >= len(lats):
                continue
            folium.CircleMarker(
                (float(lats[i]), float(lons[i])),
                radius=10, color="white", weight=2,
                fill=True, fill_color=KM_MARKER_FILL, fill_opacity=1.0,
                tooltip=f"{int(round(t))} km",
            ).add_to(fmap)

    fit_pts = []
    if course.discipline == "swim":
        beach_lat, beach_lon = 49.4527, -119.5821
        fit_pts = [(beach_lat + 0.004, beach_lon - 0.010),
                   (beach_lat - 0.012, beach_lon + 0.004)]
    else:
        fit_pts = [(float(lats.min()), float(lons.min())),
                   (float(lats.max()), float(lons.max()))]
    fmap.fit_bounds(fit_pts)
    fmap.save(str(out_html))


# ---------------------------------------------------------------------------
# Build everything
# ---------------------------------------------------------------------------
# Export bundled course data for the SPA
# ---------------------------------------------------------------------------
def export_app_data(courses, out: Path):
    """Write data/courses.json containing decimated tracks + metadata."""
    data = {}
    order = []
    for c in courses:
        order.append(c.key)
        race_name = "Ogopogo Extreme" if c.race == "extreme" else "Ogopogo 3500"
        entry = {
            "key": c.key,
            "race": c.race,
            "race_name": race_name,
            "discipline": c.discipline,
            "title": c.title,
            "distance_label": c.distance_label,
            "location": c.location,
        }
        if c.discipline == "swim":
            beach_lat, beach_lon = 49.4527, -119.5821
            lons, lats = _swim_rectangle(beach_lat, beach_lon,
                                         750, 200, rotation_deg=12)
            entry.update({
                "swim": True,
                "beach": {"lat": beach_lat, "lon": beach_lon},
                "default_view": {"lat": 49.4490, "lon": -119.5821, "zoom": 15},
                "swim_track": [
                    {"lat": round(float(la), 6), "lon": round(float(lo), 6)}
                    for la, lo in zip(lats, lons)
                ],
            })
        else:
            lats, lons, eles, dist = parse_gpx(c.gpx)
            n = len(lats)
            step = max(1, n // 1500)
            idx = list(range(0, n, step))
            if idx[-1] != n - 1:
                idx.append(n - 1)
            gain = float(np.sum(np.clip(np.diff(eles), 0, None)))
            entry.update({
                "swim": False,
                "distance_km": round(float(dist[-1]), 2),
                "elevation_gain_m": round(gain, 0),
                "start_elev_m": round(float(eles[0]), 0),
                "finish_elev_m": round(float(eles[-1]), 0),
                "track": [
                    {
                        "lat": round(float(lats[i]), 6),
                        "lon": round(float(lons[i]), 6),
                        "ele": round(float(eles[i]), 1),
                        "d": round(float(dist[i]), 3),
                    }
                    for i in idx
                ],
            })
        data[c.key] = entry

    (out / "data").mkdir(exist_ok=True)
    payload = {"order": order, "courses": data}
    (out / "data" / "courses.json").write_text(
        json.dumps(payload, separators=(",", ":"))
    )


# ---------------------------------------------------------------------------
def main():
    here = Path(__file__).parent
    out = here / "docs"
    out.mkdir(exist_ok=True)

    courses = [
        Course("extreme_swim", "extreme", "swim", "SWIM COURSE", None,
               "3.8 KILOMETERS / 2 LAPS"),
        Course("extreme_bike", "extreme", "bike", "BIKE COURSE",
               here / "Ogopogo Extreme & Relay.gpx",
               "183 KILOMETERS / 1 LAP"),
        Course("extreme_run", "extreme", "run", "RUN COURSE",
               here / "Ogopogo Extreme & Relay Run Course.gpx",
               "MARATHON / 1 LAP"),
        Course("og3500_swim", "3500", "swim", "SWIM COURSE", None,
               "1.9 KILOMETERS / 1 LAP"),
        Course("og3500_bike", "3500", "bike", "BIKE COURSE",
               here / "Ogopogo 3500.gpx",
               "83 KILOMETERS / 1 LAP"),
        Course("og3500_run", "3500", "run", "RUN COURSE",
               here / "Ogopogo 3500 Run Course.gpx",
               "HALF MARATHON / 1 LAP"),
    ]

    # First pass — compute true distances from GPX where available, update labels
    for c in courses:
        if c.gpx and c.gpx.exists():
            _, _, _, dist = parse_gpx(c.gpx)
            total = dist[-1]
            if c.discipline == "bike":
                c.distance_label = f"{total:.1f} KILOMETERS / 1 LAP"
            elif c.discipline == "run":
                # Detect half vs full marathon-ish
                if total < 25:
                    c.distance_label = f"{total:.1f} KILOMETERS  •  HALF MARATHON"
                else:
                    c.distance_label = f"{total:.1f} KILOMETERS  •  MARATHON"

    # Render each course in both PDF styles (light + satellite). The HTML
    # version is no longer per-course; everything is served by the SPA.
    global ACTIVE_STYLE
    for style_name in ("light", "satellite"):
        ACTIVE_STYLE = style_name
        suffix = "" if style_name == "light" else "_satellite"
        for c in courses:
            print(f"Rendering {c.key} [{style_name}] …")
            render_course_map(c, out / f"{c.key}{suffix}.pdf")

    # Merge into a single PDF per race (one per style)
    def merge(name: str, parts: list[str]):
        writer = PdfWriter()
        for p in parts:
            for page in PdfReader(str(out / p)).pages:
                writer.add_page(page)
        with open(out / name, "wb") as f:
            writer.write(f)

    merge("Ogopogo_Extreme_Course_Maps.pdf",
          ["extreme_swim.pdf", "extreme_bike.pdf", "extreme_run.pdf"])
    merge("Ogopogo_3500_Course_Maps.pdf",
          ["og3500_swim.pdf", "og3500_bike.pdf", "og3500_run.pdf"])
    merge("Ogopogo_Extreme_Course_Maps_Satellite.pdf",
          ["extreme_swim_satellite.pdf", "extreme_bike_satellite.pdf",
           "extreme_run_satellite.pdf"])
    merge("Ogopogo_3500_Course_Maps_Satellite.pdf",
          ["og3500_swim_satellite.pdf", "og3500_bike_satellite.pdf",
           "og3500_run_satellite.pdf"])

    # Copy logo into output so the web page can serve it
    if LOGO_PATH.exists():
        shutil.copy(LOGO_PATH, out / "logo.png")

    # Export course data + copy SPA files
    export_app_data(courses, out)
    here = Path(__file__).parent
    web_src = here / "web"
    if web_src.exists():
        for f in ("index.html", "app.js", "app.css"):
            shutil.copy(web_src / f, out / f)

    # Legacy landing page (kept for direct PDF access); SPA lives at index.html
    (out / "downloads.html").write_text(f"""<!doctype html>
<html><head><meta charset='utf-8'><title>Ogopogo Triathlon — Course Maps</title>
<style>
 body{{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:{BRAND_CREAM};color:#222}}
 header{{background:{HEADER_COLOR};color:#fff;padding:24px 32px;border-bottom:4px solid {BRAND_RED};display:flex;align-items:center;gap:24px}}
 header img{{height:88px;width:auto}}
 header .titles h1{{margin:0;font-size:28px;letter-spacing:.5px}}
 header .titles span{{color:{BRAND_CREAM};font-weight:bold;letter-spacing:3px;font-size:11px}}
 main{{max-width:1100px;margin:32px auto;padding:0 24px}}
 .race{{background:#fff;border-radius:10px;padding:22px 26px;margin-bottom:24px;
   box-shadow:0 1px 3px rgba(0,0,0,.08);border-top:5px solid {BRAND_GREEN}}}
 .race h2{{margin:0 0 14px 0;color:{BRAND_GREEN};border-bottom:3px solid {BRAND_RED};
   padding-bottom:6px;display:inline-block}}
 .grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}}
 .card{{display:block;padding:18px;border:1px solid #e3e3e3;border-radius:8px;
   text-decoration:none;color:#222;background:#fafafa;transition:.15s}}
 .card:hover{{border-color:{BRAND_RED};background:#fff;transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,.08)}}
 .card h3{{margin:0;font-size:16px;color:{HEADER_COLOR}}}
 .card p{{margin:6px 0 0 0;font-size:13px;color:#666}}
 .badge{{display:inline-block;background:{BRAND_RED};color:#fff;font-size:11px;
   padding:2px 10px;border-radius:10px;margin-right:6px;font-weight:bold;letter-spacing:1px}}
 .badge.swim{{background:{BRAND_GREEN}}}
 .badge.run{{background:{BRAND_BLACK}}}
 a.pdf{{font-size:12px;color:{BRAND_RED};text-decoration:none;font-weight:bold}}
</style></head><body>
<header>
  <img src='logo.png' alt='Ogopogo Extreme Triathlon'>
  <div class='titles'>
    <span>PENTICTON, BRITISH COLUMBIA</span>
    <h1>Race Course Maps</h1>
  </div>
</header>
<main>
  <div class='race'>
    <h2>Ogopogo Extreme</h2>
    <div class='grid'>
      <a class='card' href='extreme_swim.html'><span class='badge swim'>SWIM</span>
        <h3>Swim Course</h3><p>Skaha Beach · 3.8 km · 2 laps</p>
        <p><a class='pdf' href='extreme_swim.pdf'>PDF ▸</a></p></a>
      <a class='card' href='extreme_bike.html'><span class='badge'>BIKE</span>
        <h3>Bike Course</h3><p>Penticton → Apex Mountain</p>
        <p><a class='pdf' href='extreme_bike.pdf'>PDF ▸</a></p></a>
      <a class='card' href='extreme_run.html'><span class='badge run'>RUN</span>
        <h3>Run Course</h3><p>Marathon distance</p>
        <p><a class='pdf' href='extreme_run.pdf'>PDF ▸</a></p></a>
    </div>
    <p style='margin-top:14px'><a class='pdf' href='Ogopogo_Extreme_Course_Maps.pdf'>
      ⬇ Download full Extreme course manual PDF</a></p>
  </div>

  <div class='race'>
    <h2>Ogopogo 3500</h2>
    <div class='grid'>
      <a class='card' href='og3500_swim.html'><span class='badge swim'>SWIM</span>
        <h3>Swim Course</h3><p>Skaha Beach · 1.9 km · 1 lap</p>
        <p><a class='pdf' href='og3500_swim.pdf'>PDF ▸</a></p></a>
      <a class='card' href='og3500_bike.html'><span class='badge'>BIKE</span>
        <h3>Bike Course</h3><p>Penticton → Apex Mountain</p>
        <p><a class='pdf' href='og3500_bike.pdf'>PDF ▸</a></p></a>
      <a class='card' href='og3500_run.html'><span class='badge run'>RUN</span>
        <h3>Run Course</h3><p>Half marathon distance</p>
        <p><a class='pdf' href='og3500_run.pdf'>PDF ▸</a></p></a>
    </div>
    <p style='margin-top:14px'><a class='pdf' href='Ogopogo_3500_Course_Maps.pdf'>
      ⬇ Download full 3500 course manual PDF</a></p>
  </div>
</main>
</body></html>
""")
    print("Done. Outputs in", out)


if __name__ == "__main__":
    main()
