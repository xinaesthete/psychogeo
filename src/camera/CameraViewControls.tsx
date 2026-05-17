import { resetCameraNorthUp } from "./cameraViewCommands";
import "./CameraViewControls.css";

export function CameraViewControls() {
    return (
        <div className="CameraViewControls">
            <button
                type="button"
                className="CameraViewControls-btn"
                title="North up, look straight down"
                aria-label="Reset to north-up top-down view"
                onClick={() => resetCameraNorthUp()}
            >
                <span className="CameraViewControls-north" aria-hidden>
                    N
                </span>
            </button>
        </div>
    );
}
