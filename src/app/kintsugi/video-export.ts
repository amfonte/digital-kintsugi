import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";

import { getToolcraftVideoExportSize } from "@/toolcraft/runtime";
import type { ToolcraftState } from "@/toolcraft/runtime";

import { downloadBlob } from "./export-download";
import { getActiveKintsugiScene, turntableLoopSeconds } from "./scene";

export const kintsugiVideoFrameRates = [24, 30, 60] as const;

export type KintsugiVideoFrameRate = (typeof kintsugiVideoFrameRates)[number];

const defaultFramesPerSecond: KintsugiVideoFrameRate = 30;

// The FPS control commits its value as a string; anything unrecognized falls
// back to 30 rather than reaching the encoder as NaN.
export function readKintsugiVideoFrameRate(state: ToolcraftState): KintsugiVideoFrameRate {
  const raw = state.values["export.video.fps"];
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  const match = kintsugiVideoFrameRates.find((rate) => rate === parsed);

  return match ?? defaultFramesPerSecond;
}

export type KintsugiVideoFramePlan = {
  count: number;
  frameDurationMicros: number;
};

// Loop-timed offline frames: timestamps derive from frame index, never from the
// wall clock, so encoded duration always matches the turntable loop period no
// matter how slowly the frames actually render.
export function getKintsugiVideoFramePlan(
  durationSeconds: number,
  framesPerSecond: number = defaultFramesPerSecond,
): KintsugiVideoFramePlan {
  const clamped = Math.max(0.5, durationSeconds);

  return {
    count: Math.max(1, Math.round(clamped * framesPerSecond)),
    frameDurationMicros: Math.round(1_000_000 / framesPerSecond),
  };
}

type EncoderChoice = {
  codec: string;
  container: "mp4" | "webm";
};

// Offline rendered-frame export: every frame timestamp comes from timeline
// time, so encoded duration matches the runtime timeline duration even when
// rendering is slower or faster than real time.
async function chooseEncoder(
  requestedContainer: "mp4" | "webm",
  width: number,
  height: number,
  framesPerSecond: number,
): Promise<EncoderChoice> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("Video export requires WebCodecs support in this browser.");
  }

  const candidates: EncoderChoice[] =
    requestedContainer === "mp4"
      ? [
          { codec: "avc1.640034", container: "mp4" },
          { codec: "avc1.64002A", container: "mp4" },
          { codec: "vp09.00.50.08", container: "webm" },
          { codec: "vp8", container: "webm" },
        ]
      : [
          { codec: "vp09.00.50.08", container: "webm" },
          { codec: "vp8", container: "webm" },
          { codec: "avc1.640034", container: "mp4" },
        ];

  for (const candidate of candidates) {
    const support = await VideoEncoder.isConfigSupported({
      codec: candidate.codec,
      framerate: framesPerSecond,
      height,
      width,
    });

    if (support.supported) {
      return candidate;
    }
  }

  throw new Error("No supported video encoder configuration was found.");
}

function waitForEncoderQueue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    encoder.addEventListener("dequeue", () => resolve(), { once: true });
  });
}

export async function exportKintsugiVideo(
  state: ToolcraftState,
  reportProgress: (progress: number) => void,
): Promise<void> {
  const scene = getActiveKintsugiScene();

  if (!scene) {
    throw new Error("Kintsugi scene is not ready for video export.");
  }

  const resolutionRaw = state.values["export.video.resolution"];
  const resolution = typeof resolutionRaw === "string" ? resolutionRaw : "current";
  const formatRaw = state.values["export.video.format"];
  const requestedContainer = formatRaw === "webm" ? "webm" : "mp4";
  const { height, width } = getToolcraftVideoExportSize({ resolution, state });
  const framesPerSecond = readKintsugiVideoFrameRate(state);
  const choice = await chooseEncoder(requestedContainer, width, height, framesPerSecond);
  // One clip is exactly one turntable revolution; FPS changes how finely that
  // revolution is sampled, never how long it runs.
  const { count: totalFrames, frameDurationMicros } = getKintsugiVideoFramePlan(
    turntableLoopSeconds,
    framesPerSecond,
  );

  const mp4Target = choice.container === "mp4" ? new Mp4Target() : null;
  const webmTarget = choice.container === "webm" ? new WebmTarget() : null;
  const mp4Muxer = mp4Target
    ? new Mp4Muxer({
        fastStart: "in-memory",
        target: mp4Target,
        video: { codec: "avc", height, width },
      })
    : null;
  const webmMuxer = webmTarget
    ? new WebmMuxer({
        target: webmTarget,
        video: {
          codec: choice.codec === "vp8" ? "V_VP8" : "V_VP9",
          frameRate: framesPerSecond,
          height,
          width,
        },
      })
    : null;

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    error: (error) => {
      encodeError = error instanceof Error ? error : new Error(String(error));
    },
    output: (chunk, metadata) => {
      if (mp4Muxer) {
        mp4Muxer.addVideoChunk(chunk, metadata);
      } else {
        webmMuxer?.addVideoChunk(chunk, metadata);
      }
    },
  });

  encoder.configure({
    bitrate: 12_000_000,
    codec: choice.codec,
    framerate: framesPerSecond,
    height,
    width,
  });

  const session = scene.createExportSession(width, height);

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      if (encodeError) {
        throw encodeError;
      }

      const turntableTime = frameIndex / framesPerSecond;
      const frameCanvas = session.renderFrame(turntableTime, true);
      const videoFrame = new VideoFrame(frameCanvas, {
        duration: frameDurationMicros,
        timestamp: frameIndex * frameDurationMicros,
      });

      encoder.encode(videoFrame, { keyFrame: frameIndex % (framesPerSecond * 2) === 0 });
      videoFrame.close();

      if (encoder.encodeQueueSize > 4) {
        await waitForEncoderQueue(encoder);
      }

      if (frameIndex % 6 === 5) {
        await new Promise((resolve) => {
          window.setTimeout(resolve, 0);
        });
      }

      reportProgress(((frameIndex + 1) / totalFrames) * 0.95);
    }

    await encoder.flush();
    encoder.close();

    if (encodeError) {
      throw encodeError;
    }

    let blob: Blob;

    if (mp4Muxer && mp4Target) {
      mp4Muxer.finalize();
      blob = new Blob([mp4Target.buffer], { type: "video/mp4" });
    } else if (webmMuxer && webmTarget) {
      webmMuxer.finalize();
      blob = new Blob([webmTarget.buffer], { type: "video/webm" });
    } else {
      throw new Error("Video muxer was not initialized.");
    }

    reportProgress(1);
    downloadBlob(
      blob,
      choice.container === "mp4" ? "kintsugi-turntable.mp4" : "kintsugi-turntable.webm",
    );
  } finally {
    session.dispose();

    if (encoder.state !== "closed") {
      encoder.close();
    }
  }
}
