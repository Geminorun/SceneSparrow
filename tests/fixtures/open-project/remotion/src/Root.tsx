import React from "react";
import {
  AbsoluteFill,
  Composition,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

const Bird: React.FC = () => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 23], [20, 220]);
  return (
    <AbsoluteFill style={{ backgroundColor: "#17344d" }}>
      <Img
        src={staticFile("images/bird.svg")}
        style={{
          position: "absolute",
          top: 45,
          left: x,
          width: 60,
          height: 60,
        }}
      />
    </AbsoluteFill>
  );
};
export const Root: React.FC = () => (
  <Composition
    id="OpenProjectExample"
    component={Bird}
    width={320}
    height={180}
    fps={24}
    durationInFrames={24}
  />
);
