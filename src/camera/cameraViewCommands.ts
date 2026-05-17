export type CameraViewCommands = {
    resetNorthUp: () => void;
};

let active: CameraViewCommands | null = null;

export function registerCameraViewCommands(commands: CameraViewCommands | null): void {
    active = commands;
}

export function resetCameraNorthUp(): void {
    active?.resetNorthUp();
}
