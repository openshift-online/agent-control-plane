#!/usr/bin/env python3
"""Open a preseeded Chrome extension toolbar action and log the visible click."""

import argparse
import json
import subprocess
import time

import pyatspi


def text_for(accessible):
    parts = [getattr(accessible, "name", "") or "", getattr(accessible, "description", "") or ""]
    return " ".join(parts).lower()


def descendants(root, maximum=10000):
    pending = [root]
    seen = 0
    while pending and seen < maximum:
        item = pending.pop(0)
        seen += 1
        yield item
        try:
            pending.extend(item[i] for i in range(item.childCount))
        except (AttributeError, LookupError, RuntimeError):
            continue


def is_push_button(item):
    try:
        return item.getRole() == pyatspi.ROLE_PUSH_BUTTON
    except (AttributeError, LookupError, RuntimeError):
        return False


def find_matching(root, terms):
    lowered = [term.lower() for term in terms if term]
    for item in descendants(root):
        # The extension toolbar action is a push button in the browser chrome;
        # restrict matching to push buttons so unrelated accessibles (labels,
        # page-content links, menus) cannot be selected by name/description.
        if not is_push_button(item):
            continue
        text = text_for(item)
        if any(term in text for term in lowered):
            return item
    return None


def click_accessible(accessible, args):
    component = accessible.queryComponent()
    extents = component.getExtents(pyatspi.DESKTOP_COORDS)
    if extents.width <= 0 or extents.height <= 0:
        raise RuntimeError("matching browser control has no visible AT-SPI bounds")
    x = round(extents.x + extents.width / 2)
    y = round(extents.y + extents.height / 2)
    normalized_x = min(1.0, max(0.0, (x - args.window_x) / args.window_width))
    normalized_y = min(1.0, max(0.0, (y - args.window_y) / args.window_height))
    with open(args.pointer_output, "a", encoding="utf-8") as stream:
        stream.write(json.dumps({
            "type": "click",
            "monotonicSeconds": time.monotonic(),
            "x": normalized_x,
            "y": normalized_y,
        }, separators=(",", ":")) + "\n")
    subprocess.run(
        [args.xdotool, "mousemove", "--sync", str(x), str(y), "click", "1"],
        check=True,
    )


def chrome_application(name):
    desktop = pyatspi.Registry.getDesktop(0)
    for application in descendants(desktop):
        if name.lower() in (getattr(application, "name", "") or "").lower():
            return application
    raise RuntimeError(f"{name} is not exposed on the AT-SPI bus")


def open_extension(args):
    application = chrome_application(args.application_name)
    terms = [args.extension_name, args.extension_id]
    action = find_matching(application, terms)
    if action is None:
        raise RuntimeError("preseeded extension toolbar action is absent from Chrome AT-SPI")
    click_accessible(action, args)
    return {"pressed": True, "pinned": True, "preseeded": True}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--application-name", default="Google Chrome for Testing")
    parser.add_argument("--extension-name", required=True)
    parser.add_argument("--extension-id", required=True)
    parser.add_argument("--pointer-output", required=True)
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--window-x", type=int, required=True)
    parser.add_argument("--window-y", type=int, required=True)
    parser.add_argument("--window-width", type=int, required=True)
    parser.add_argument("--window-height", type=int, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(open_extension(parse_args()), separators=(",", ":")))
