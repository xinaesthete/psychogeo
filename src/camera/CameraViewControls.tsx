import { resetCameraNorthUpOblique } from "./cameraViewCommands";
import "./CameraViewControls.css";

export function CameraViewControls() {
    return (
        <div className="CameraViewControls">
            <button
                type="button"
                className="CameraViewControls-btn"
                title="North up, oblique view"
                aria-label="Reset to north-up oblique view"
                onClick={() => resetCameraNorthUpOblique()}
            >
                <span className="CameraViewControls-north" aria-hidden>
                    N
                </span>
            </button>
        </div>
    );
}
