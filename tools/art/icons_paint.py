#!/usr/bin/env python3
"""Store art: the colour app icons the Cardputer Store shows.

Each icon repeats the motif of the app's own launcher icon (files/device-icon.txt, 1-bit pixel art): the store
shows the same app the system shows, in colour. Painted with Qwen-Image 2.1 in the local ComfyUI (the sprite-forge
client): ONE 5x5 grid of 25 full-bleed square icons per render, 1024x1024, 20 steps, cfg 2.5 (~200 px per cell,
4x the 48 px they are stored at). Same prompt + seed = same picture. Raws and cut cells (256 px PNG) land in
tools/art/_raw/ (not published); tools/art/picks.txt names the cell chosen for each app, copied to
apps/<ch>/<id>/store-icon.png (art/channels/<name>.png for the stores' own icons), and tools/art_pack.py packs them.

    python tools/art/icons_paint.py [--cand 0 1] [--only grid25,grid25b]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.expanduser("~/.claude/skills/sprite-forge/scripts"))
import forge  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "_raw")
SEED = 6201

# (name, emblem + background) in reading order; the last five are alternatives for the hardest motifs.
CELLS = [
    ("brawler", "a black silhouette fighter delivering a flying kick to another silhouette, on a crimson to black gradient"),
    ("cardler", "a little knight holding a sword next to a small cottage with a pointed roof, on a meadow green gradient"),
    ("dice", "one big white die showing five pips with a small white die beside it, on a royal purple gradient"),
    ("giardino", "a round leafy green tree growing in a wooden planter box, on a soft mint gradient"),
    ("orde", "a small glowing hero in the centre surrounded by a ring of many tiny dark enemies, on a dark violet gradient"),
    ("pinball", "a pinball table seen from above with a round bumper, a silver ball and two flippers, on an electric blue gradient"),
    ("poker", "two playing cards, the front card with one big black spade, on a casino green felt gradient"),
    ("pong", "two white vertical paddles, a dashed centre line and a glowing white ball, on a neon navy gradient"),
    ("reactor", "an atom with three glowing elliptical orbits around a bright nucleus, on an orange to steel grey gradient"),
    ("slots", "a slot machine with three reel windows and a side lever, on a gold to ruby gradient"),
    ("snake", "a bright green snake moving along a zigzag staircase path towards a red apple, on a dark green gradient"),
    ("stelle", "a constellation of bright white stars joined by thin glowing lines, on a deep space indigo gradient"),
    ("tankd", "two small tanks seen from above facing each other inside an arena, on a sandy orange gradient"),
    ("tanks", "an artillery tank on a hill firing a shell high into the sky, on a sunset orange to purple gradient"),
    ("units", "two thick opposite arrows, one pointing right and one pointing left, above a yellow ruler, on a sky blue gradient"),
    ("yahtzee", "five white dice in two rows on a small wooden tray, on a vivid magenta gradient"),
    ("metronome", "a pyramid metronome with a swinging pendulum, on a warm amber gradient"),
    ("scoreboard", "a scoreboard on a stand with two big glowing blank panels side by side, on a teal gradient"),
    ("@native", "a glowing microchip with golden pins on a circuit board pattern, on a coral red gradient"),
    ("@web", "a globe of glowing meridian lines inside a browser window outline, on a cobalt blue gradient"),
    ("orde.b", "a round blue shield in the centre surrounded by many small red eyes, on a near black gradient"),
    ("units.b", "a ruler and a thermometer side by side with a circular exchange arrow around them, on a sky blue gradient"),
    ("brawler.b", "a red boxing glove punching forward with speed lines, on a dark crimson gradient"),
    ("tankd.b", "two small cartoon tanks side by side facing each other with cannons pointing at each other, on a sandy orange gradient"),
    ("snake.b", "a friendly green snake curled in a spiral next to a red apple, on a dark green gradient"),
]

# Grid 2 (seed 6301): the emulators that joined later, and alternatives for the weakest of grid 1.
CELLS2 = [
    ("gbemu", "a generic classic grey portrait handheld game console with a small green screen, a d-pad and two round buttons, on a lime green gradient"),
    ("ggemu", "a generic black landscape handheld game console with a wide colour screen between a d-pad and two buttons, on a deep blue gradient"),
    ("gbemu.b", "a generic grey portrait handheld game console seen from the front, a game cartridge plugged in on top, on a soft olive green gradient"),
    ("ggemu.b", "a generic black landscape handheld game console with a glowing colourful screen, on a royal blue to cyan gradient"),
    ("stelle.b", "a small silver spaceship flying past a glowing constellation of stars joined by lines, on a deep space indigo gradient"),
    ("stelle.c", "a glowing golden lighthouse beacon star with a constellation around it, on a deep space indigo gradient"),
    ("scoreboard.b", "a small golden trophy in front of a scoreboard with two rows of glowing tally marks, on a teal gradient"),
    ("scoreboard.c", "a scoreboard on a stand with two big glowing yellow panels and a small golden star above, on a teal gradient"),
    ("cardler.b", "a little knight with a red cape and a sword in front of a village house, simple and bold, on a meadow green gradient"),
    ("cardler.c", "a treasure map scroll with a small sword lying across it, on a warm meadow green gradient"),
    ("tankd.c", "two small bold tanks seen from above facing each other across a dusty arena, simple shapes, on a sandy orange gradient"),
    ("tanks.b", "a bold artillery tank on a green hill firing a glowing shell along a curved arc, on a sunset gradient"),
    ("pong.b", "two glowing white paddles and a glowing white ball with a dashed centre line, on a neon purple to navy gradient"),
    ("giardino.b", "a small golden tree with round glowing golden leaves in a terracotta pot, on a soft mint gradient"),
    ("reactor.b", "a glowing green reactor core cylinder with energy rings and a warning stripe, on a dark steel gradient"),
    ("poker.b", "a fan of three playing cards, an ace of spades in front, with a red poker chip, on a casino green felt gradient"),
    ("slots.b", "a shiny slot machine reel window showing three red sevens and a golden lever, on a gold to ruby gradient"),
    ("yahtzee.b", "five white dice falling out of a red leather dice cup, on a vivid magenta gradient"),
    ("dice.b", "two red translucent dice tumbling with motion lines, on a royal purple gradient"),
    ("metronome.b", "a modern metronome with a swinging pendulum and a small glowing musical note, on a warm amber gradient"),
    ("pinball.b", "a shiny silver pinball ball bouncing off a glowing red round bumper with two flippers below, on an electric blue gradient"),
    ("brawler.b2", "two black silhouette street fighters mid-fight, one kicking, under a red neon light, on a crimson to black gradient"),
    ("orde.c", "a small glowing hero with a sword in the centre surrounded by a ring of dark red-eyed monsters, on a dark violet gradient"),
    ("snake.c", "a friendly bright green snake slithering in a zigzag line towards a red apple, on a dark green gradient"),
    ("units.c", "a yellow ruler and a red thermometer side by side under two thick opposite white arrows, left and right, on a sky blue gradient"),
]

LEAD = ("A 5x5 grid of 25 separate, equally sized square panels separated by thin white lines. Every panel is ONE "
        "complete modern mobile app icon filling the whole panel edge to edge: a smooth rich colour gradient "
        "background covering the entire panel and one big bold simple emblem in the centre with clean glossy "
        "vector-like shading and a strong simple silhouette that reads at 48 pixels. The panels, left to right, top "
        "to bottom:")
TAIL = "Polished flat-design app store icons, soft highlights, crisp shapes, vivid colours, no text, no letters, no numbers."
NEG = ("text, letters, numbers, digits, words, watermark, signature, frame inside a panel, white margin, photo, "
       "clutter, tiny details, dark muddy colours, merged panels")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cand", type=int, nargs="+", default=[0, 1])
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default="", help="grid25 and/or grid25b")
    a = ap.parse_args()
    os.makedirs(RAW, exist_ok=True)
    models = forge.host_models()
    for tag, seed, cells in (("grid25", SEED, CELLS), ("grid25b", 6301, CELLS2)):
        if a.only and tag not in a.only.split(","):
            continue
        prompt = " ".join([LEAD] + [f"{i + 1}. {txt}." for i, (_, txt) in enumerate(cells)] + [TAIL])
        for k in a.cand:
            raw = os.path.join(RAW, f"{tag}_c{k}.png")
            if os.path.exists(raw) and not a.force:
                img = forge.Image.open(raw).convert("RGB")
            else:
                print(f"{tag} cand {k} (seed {seed + k * 7919})", flush=True)
                img = forge.run(forge.build_graph(prompt, NEG, 1024, 1024, seed + k * 7919, models=models), f"{tag}_c{k}")
                img.save(raw)
            for (name, _), cell in zip(cells, forge.cells(img, 5, 0.03)):
                cell.resize((256, 256), forge.Image.LANCZOS).save(os.path.join(RAW, f"{name.lstrip('@')}_c{k}.png"))


if __name__ == "__main__":
    main()
