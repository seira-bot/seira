import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CarvedAvatar, REST_POSE, carvedFills, carvedGeometry, hairTint } from "./CarvedAvatar";
import { MausAvatar } from "./Avatar";
import { BRAND_BODY_IDS, CARVED_BODIES, CARVED_BODY_IDS } from "../../shared/carved-bodies";
import { isBrandBody } from "../../shared/bot-body";
import { MAUS_COLORS } from "@/lib/mascot";
import { hairGradientMap } from "@/lib/seira-hair";
import { accessorySprites } from "@/lib/seira-accessories";
import type { MascotAccessoryId } from "../../shared/mascot-accessories";

const STYLE_IDS = BRAND_BODY_IDS.filter((id) => id !== "seira");

const render = (body: (typeof CARVED_BODY_IDS)[number], color: "orange" | "purple" | "chrome" | "silver" = "orange", faceColor: "white" | "black" | null = null) =>
  renderToStaticMarkup(createElement(CarvedAvatar, { body, color, faceColor, animated: false, label: body }));
const wear = (body: (typeof CARVED_BODY_IDS)[number], accessories: MascotAccessoryId[]) =>
  renderToStaticMarkup(createElement(CarvedAvatar, { body, color: "orange", animated: false, accessories }));
const viewBox = (markup: string) => /viewBox="([^"]+)"/.exec(markup)![1]!.split(" ").map(Number);

describe("CarvedAvatar", () => {
  it("draws every part, two eyes, and a smile unless the drawing has its own mouth", () => {
    for (const id of CARVED_BODY_IDS.filter((id) => !isBrandBody(id))) {
      const markup = render(id);
      const body = CARVED_BODIES[id];
      expect(markup).toContain(`data-carved-body="${id}"`);
      expect(markup.match(/<rect /g)?.length, id).toBe(2);
      expect(markup.match(/<path /g)?.length, id).toBe(body.parts.length + 1 + (body.eyes.mouth ? 1 : 0));
      expect(markup.includes("<ellipse"), id).toBe(body.eyes.mouth);
    }
  });

  it("draws Seira from her rendered head, with two eyes and a smile on the visor", () => {
    const markup = render("seira", "chrome");
    expect(markup).toContain('data-carved-body="seira"');
    expect(markup).toMatch(/<image href="[^"]*front-\d+\.webp"/);
    expect(markup.match(/<rect /g)?.length).toBe(2);
    expect(markup.match(/<path /g)?.length).toBe(2);
    expect(markup).not.toContain("mix-blend-mode");
  });

  it("tints Seira's hair with the bot's colour, and keeps it white for silver and chrome", () => {
    const markup = render("seira", "orange");
    expect(markup).toMatch(/<mask id="hair-[^"]+"[^>]*><image href="[^"]*hair-\d+\.png"/);
    expect(markup).toContain(`fill="${hairTint("orange")}"`);
    expect(markup).toContain("mix-blend-mode:multiply");
    expect(hairTint("chrome")).toBeNull();
    expect(hairTint("silver")).toBeNull();
    expect(carvedFills(CARVED_BODIES.seira, "chrome").body).toBe(CARVED_BODIES.seira.bone);
    expect(carvedFills(CARVED_BODIES.seira, "blue").body).toBe(carvedFills(CARVED_BODIES.pumpkin, "blue").body);
  });

  it.each(["white", "black", null] as const)("keeps Seira's eyes red with the %s face colour", (faceColor) => {
    const markup = render("seira", "chrome", faceColor);
    expect(markup.match(/<rect [^>]*fill="#e11d48"/g)?.length).toBe(2);
    expect(markup).toContain('stroke="#e11d48"');
  });

  it("draws every other hair style from its own rendered head, with Seira's red eyes", () => {
    expect(STYLE_IDS).toHaveLength(16);
    for (const id of STYLE_IDS) {
      const markup = render(id, "chrome", "white");
      expect(markup, id).toMatch(new RegExp(`<image href="[^"]*seira-hair/${id}/front-\\d+\\.webp"`));
      expect(markup.match(/<rect /g)?.length, id).toBe(2);
      expect(markup.match(/<rect [^>]*fill="#e11d48"/g)?.length, id).toBe(2);
      expect(markup.match(/<path /g)?.length, id).toBe(2);
      expect(markup, id).not.toContain("feComponentTransfer");
    }
  });

  it("tints the hair of each style with the bot's colour, and keeps Seira's silver for silver and chrome", () => {
    const markup = render("bob", "orange");
    expect(markup).toMatch(/<image href="[^"]*seira-hair\/bob\/hair-\d+\.webp"[^>]*filter="url\(#hair-[^"]+\)"/);
    for (const table of hairGradientMap(hairTint("orange")!)) expect(markup).toContain(`tableValues="${table}"`);
    expect(markup).not.toContain("mix-blend-mode");
    expect(render("bob", "silver")).not.toMatch(/hair-\d+\.webp/);
    expect(carvedFills(CARVED_BODIES.bob, "chrome").body).toBe(CARVED_BODIES.seira.bone);
    expect(carvedFills(CARVED_BODIES.bob, "blue").body).toBe(carvedFills(CARVED_BODIES.seira, "blue").body);
  });

  it("draws no hair layer on the style without hair", () => {
    const markup = render("none", "orange");
    expect(markup).toMatch(/seira-hair\/none\/front-\d+\.webp/);
    expect(markup).not.toContain("feComponentTransfer");
  });

  it("draws the accessories over the face, one in each slot, in the order given", () => {
    const markup = wear("bob", ["glasses", "sunglasses", "cap", "scarf"]);
    expect([...markup.matchAll(/data-accessory="([^"]+)"/g)].map((match) => match[1])).toEqual(["glasses", "cap", "scarf"]);
    expect(markup).toMatch(/<image href="[^"]*seira-accessory\/glasses\.webp"/);
    expect(markup.indexOf("data-accessory")).toBeGreaterThan(markup.lastIndexOf("<rect "));
    expect(render("bob")).not.toContain("data-accessory");
  });

  it("places every accessory on every hair style, and glasses on the eyes", () => {
    for (const id of BRAND_BODY_IDS) {
      const eyes = CARVED_BODIES[id].eyes;
      const sprites = accessorySprites(id, ["glasses", "earring", "cap", "scarf"], eyes);
      expect(sprites.map((sprite) => sprite.id), id).toEqual(["glasses", "earring", "cap", "scarf"]);
      const glasses = sprites[0]!;
      expect(Math.abs(glasses.x + glasses.width / 2 - eyes.cx), id).toBeLessThan(3);
      expect(glasses.y, id).toBeLessThan(eyes.cy);
      expect(glasses.y + glasses.height, id).toBeGreaterThan(eyes.cy);
    }
  });

  it("keeps the avatar box, and grows the view only when an accessory reaches out of it", () => {
    expect(viewBox(render("seira"))).toEqual([-14, -14, 268, 268]);
    expect(viewBox(wear("seira", ["glasses"]))).toEqual([-14, -14, 268, 268]);
    const [x, y, width, height] = viewBox(wear("spiky", ["antenna"]));
    const [antenna] = accessorySprites("spiky", ["antenna"], CARVED_BODIES.spiky.eyes);
    expect(width).toBe(height);
    expect(width).toBeGreaterThan(268);
    expect(x! + width! / 2).toBeCloseTo(120, 1);
    expect(y).toBeLessThanOrEqual(antenna!.y);
    expect(y! + height!).toBeGreaterThanOrEqual(254);
  });

  it("maps the grey hair to the colour at full shade, and to a lighter highlight above it", () => {
    const [red, green, blue] = hairGradientMap("#804020").map((table) => table.split(" ").map(Number));
    expect(red).toHaveLength(13);
    expect([red![0], green![0], blue![0]]).toEqual([0, 0, 0]);
    expect(red![10]).toBeCloseTo(0x80 / 255, 2);
    expect(blue![10]).toBeCloseTo(0x20 / 255, 2);
    expect(red![12]).toBeGreaterThan(red![10]!);
  });

  it.each(["pumpkin", "laddu", "bob"] as const)("is what MausAvatar wears for the %s body", (bodyId) => {
    const markup = renderToStaticMarkup(createElement(MausAvatar, { color: "orange", bodyId, animated: false }));
    expect(markup).toContain(`data-carved-body="${bodyId}"`);
    expect(markup).not.toContain("linearGradient");
  });

  it("fills flat with the bot's colour, pale for the ghost, bone for the skull", () => {
    expect(render("pumpkin")).not.toContain("linearGradient");
    expect(carvedFills(CARVED_BODIES.pumpkin, "orange").body).not.toBe(MAUS_COLORS.orange);
    expect(carvedFills(CARVED_BODIES.ghost, "purple").body).toMatch(/^#[e-f]/);
    expect(carvedFills(CARVED_BODIES.skull, "purple").body).toBe(CARVED_BODIES.skull.bone);
  });

  it("paints firecrackers in the bot's colour and sweets in their own", () => {
    expect(carvedFills(CARVED_BODIES.rocket, "blue").body).toBe(carvedFills(CARVED_BODIES.pumpkin, "blue").body);
    expect(carvedFills(CARVED_BODIES.laddu, "blue").body).toBe(CARVED_BODIES.laddu.bone);
    expect(carvedFills(CARVED_BODIES.jalebi, "purple").body).toBe(carvedFills(CARVED_BODIES.jalebi, "green").body);
  });

  it("opens round eyes and an open mouth when startled", () => {
    const body = CARVED_BODIES.pumpkin;
    const rest = carvedGeometry(body, REST_POSE);
    const wide = carvedGeometry(body, { ...REST_POSE, wide: 1 });
    expect(rest.eyes[0].height).toBeGreaterThan(rest.eyes[0].width * 1.5);
    expect(Math.abs(wide.eyes[0].height - wide.eyes[0].width)).toBeLessThan(body.eyes.round * 0.1);
    expect(rest.smile.opacity).toBe(1);
    expect(wide.smile.opacity).toBe(0);
    expect(wide.open.opacity).toBe(1);
  });

  it("closes the eyes and follows the gaze", () => {
    const body = CARVED_BODIES.cat;
    const shut = carvedGeometry(body, { ...REST_POSE, shut: 1 });
    expect(shut.eyes[0].height).toBeLessThan(body.eyes.h * 0.15);
    const left = carvedGeometry(body, { ...REST_POSE, gx: -1 });
    const rest = carvedGeometry(body, REST_POSE);
    expect(left.eyes[0].x).toBeLessThan(rest.eyes[0].x);
    expect(left.body).toContain("rotate(9)");
  });
});
