import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
export type CompositionProps = {
  title: string;
  background: string;
  accent: string;
  direction: "left" | "right";
};
export function MotionSample({
  title,
  background,
  accent,
  direction,
}: CompositionProps) {
  const frame = useCurrentFrame();
  const x = interpolate(
    frame,
    [0, 59],
    direction === "right" ? [-180, 180] : [180, -180],
  );
  return (
    <AbsoluteFill
      style={{
        background,
        alignItems: "center",
        justifyContent: "center",
        color: accent,
        fontFamily: "sans-serif",
      }}
    >
      <Img
        src={staticFile("sparrow.svg")}
        style={{
          width: 72,
          height: 72,
          transform: `translateX(${x}px) rotate(${frame * 3}deg)`,
        }}
      />
      <h1
        style={{
          maxWidth: 600,
          textAlign: "center",
          fontSize: 34,
          overflowWrap: "anywhere",
        }}
      >
        {title}
      </h1>
    </AbsoluteFill>
  );
}
