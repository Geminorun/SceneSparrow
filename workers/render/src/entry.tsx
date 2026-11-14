import { Composition, registerRoot } from "remotion";
import { MotionSample, sampleMetadata } from "@scenesparrow/video-runtime";

function Root() {
  return (
    <Composition
      id="MotionSample"
      component={MotionSample}
      durationInFrames={sampleMetadata.durationInFrames}
      fps={sampleMetadata.fps}
      width={sampleMetadata.compositionWidth}
      height={sampleMetadata.compositionHeight}
    />
  );
}
registerRoot(Root);
