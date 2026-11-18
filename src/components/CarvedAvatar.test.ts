import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CarvedAvatar, REST_POSE, carvedFills, carvedGeometry, hairTint } from "./CarvedAvatar";
import { MausAvatar } from "./Avatar";
import { BRAND_BODY_IDS, CARVED_BODIES, CARVED_BODY_IDS } from "../../shared/carved-bodies";
import { isBrandBody } from "../../shared/bot-body";
import { MAUS_COLORS } from "@/lib/mascot";
import { castHairMap } from "@/lib/cast-body";

const CAST_IDS = BRAND_BODY_IDS.filter((id) => id !== "seira");

const render = (body: (typeof CARVED_BODY_IDS)[number], color: "orange" | "purple" | "chrome" | "silver" = "orange", faceColor: "white" | "black" | null = null) =>
  renderToStaticMarkup(createElement(CarvedAvatar, { body, color, faceColor, animated: false, label: body }));

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

  it("draws every cast body from its own rendered head, with two eyes in its own eye colour", () => {
    expect(CAST_IDS).toHaveLength(25);
    for (const id of CAST_IDS) {
      const markup = render(id, "chrome", "white");
      expect(markup, id).toMatch(new RegExp(`<image href="[^"]*cast-body/${id}/front-\\d+\\.webp"`));
      expect(markup.match(/<rect /g)?.length, id).toBe(2);
      expect(markup.match(new RegExp(`<rect [^>]*fill="${CARVED_BODIES[id].eyes.ink}"`, "g"))?.length, id).toBe(2);
      expect(markup.match(/<path /g)?.length, id).toBe(2);
      expect(markup, id).not.toContain("feComponentTransfer");
    }
  });

  it("tints the cast's hair with the bot's colour, and shows each preset's own hair for silver and chrome", () => {
    const markup = render("rhea", "orange");
    expect(markup).toMatch(/<image href="[^"]*cast-body\/rhea\/hair-\d+\.webp"[^>]*filter="url\(#hair-[^"]+\)"/);
    for (const table of castHairMap(hairTint("orange")!)) expect(markup).toContain(`tableValues="${table}"`);
    expect(markup).not.toContain("mix-blend-mode");
    expect(render("rhea", "silver")).not.toContain("hair-");
    expect(carvedFills(CARVED_BODIES.rhea, "chrome").body).toBe("#B8232F");
    expect(carvedFills(CARVED_BODIES.rhea, "blue").body).toBe(carvedFills(CARVED_BODIES.pumpkin, "blue").body);
  });

  it("maps the grey hair to the colour at full shade, and to a lighter highlight above it", () => {
    const [red, green, blue] = castHairMap("#804020").map((table) => table.split(" ").map(Number));
    expect(red).toHaveLength(13);
    expect([red![0], green![0], blue![0]]).toEqual([0, 0, 0]);
    expect(red![10]).toBeCloseTo(0x80 / 255, 2);
    expect(blue![10]).toBeCloseTo(0x20 / 255, 2);
    expect(red![12]).toBeGreaterThan(red![10]!);
  });

  it.each(["pumpkin", "laddu", "rhea"] as const)("is what MausAvatar wears for the %s body", (bodyId) => {
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
