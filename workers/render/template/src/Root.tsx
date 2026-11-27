import { Composition } from "remotion";
import { MotionSample, type CompositionProps } from "./MotionSample";
import composition from "../composition.json";
export const Root = () => (
  <Composition
    id="MotionSample"
    component={MotionSample}
    durationInFrames={60}
    fps={30}
    width={640}
    height={360}
    defaultProps={composition as CompositionProps}
  />
);
