#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCard } from "./card.mjs";
import { DEFAULT_FPS, DEFAULT_HEIGHT, DEFAULT_WIDTH, parseArguments, positiveInteger, requiredOption } from "./common.mjs";
import { renderDoctor } from "./doctor.mjs";
import { renderSlides } from "./slides.mjs";
import { renderTerminal } from "./terminal.mjs";

function dimensions(options) {
  return {
    width: positiveInteger(options.width ?? DEFAULT_WIDTH, "width"),
    height: positiveInteger(options.height ?? DEFAULT_HEIGHT, "height"),
  };
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseArguments(rest);
  if (command === "doctor") {
    const required = typeof options.require === "string" ? options.require.split(",").filter(Boolean) : [];
    const result = await renderDoctor({
      required,
      skillRoot: options.skill_root,
      presentermPath: options.presenterm,
      vhsPath: options.vhs,
      ffmpegPath: options.ffmpeg,
      browserPath: options.browser,
    });
    print(result);
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (command === "slides") {
    const result = await renderSlides({
      input: requiredOption(options, "input"),
      outputDir: requiredOption(options, "output_dir"),
      ...dimensions(options),
      dryRun: options.dry_run === true,
      presentermPath: options.presenterm,
      browserPath: options.browser,
      fontsDir: options.fonts_dir,
      theme: options.theme,
    });
    print(result);
    return result;
  }
  if (command === "terminal") {
    const result = await renderTerminal({
      input: requiredOption(options, "input"),
      output: requiredOption(options, "output"),
      ...dimensions(options),
      fps: positiveInteger(options.fps ?? DEFAULT_FPS, "fps"),
      fontSize: options.font_size ? positiveInteger(options.font_size, "font-size") : undefined,
      dryRun: options.dry_run === true,
      vhsPath: options.vhs,
      ffmpegPath: options.ffmpeg,
    });
    print(result);
    return result;
  }
  if (command === "card") {
    const skillRoot = resolve(options.skill_root ?? fileURLToPath(new URL("../..", import.meta.url)));
    const result = await renderCard({
      kind: options.kind ?? "title",
      title: requiredOption(options, "title"),
      subtitle: options.subtitle ?? "",
      label: options.label,
      output: requiredOption(options, "output"),
      htmlOutput: options.html_output,
      ...dimensions(options),
      fontsDir: options.fonts_dir ?? resolve(skillRoot, "assets/fonts"),
      logoPath: options.logo ?? resolve(skillRoot, "assets/branding/acp-logo.svg"),
      browserPath: options.browser,
      dryRun: options.dry_run === true,
    });
    print(result);
    return result;
  }
  throw new Error("usage: render <doctor|slides|terminal|card> [options]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`render: ${error.message}\n`);
    process.exitCode = 1;
  });
}
