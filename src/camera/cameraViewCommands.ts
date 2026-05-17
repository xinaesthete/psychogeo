export type CameraViewCommands = {
    resetNorthUpOblique: () => void;
};

let active: CameraViewCommands | null = null;

export function registerCameraViewCommands(commands: CameraViewCommands | null): void {
    active = commands;
}

export function resetCameraNorthUpOblique(): void {
    active?.resetNorthUpOblique();
}
