import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const sampleMetadata = {
  durationInFrames: 30,
  fps: 30,
  compositionWidth: 640,
  compositionHeight: 360,
};

export function MotionSample() {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 29], [-180, 180]);
  return (
    <AbsoluteFill
      style={{
        background: "#142d27",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 92,
          height: 92,
          borderRadius: 24,
          background: "#d9edb2",
          transform: `translateX(${x}px) rotate(${frame * 3}deg)`,
        }}
      />
    </AbsoluteFill>
  );
}
