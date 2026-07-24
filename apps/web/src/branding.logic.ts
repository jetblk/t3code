// `jetblk` is this fork's release channel (`0.0.28-jetblk.<date>.<run>`, stamped by
// .github/workflows/nightly-fork.yml). It tracks upstream's nightly cadence, so it gets
// upstream's nightly treatment: the "Nightly" stage label, sidebar night-sky backdrop,
// and composer button art.
const NIGHTLY_SERVER_VERSION_PATTERN = /-(?:nightly|jetblk)\.\d{8}\.\d+$/;

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (input.stageLabel.trim().toLowerCase() === "latest") {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

export function resolveServerBackedAppStageLabel(input: {
  readonly primaryServerVersion: string | null | undefined;
  readonly fallbackStageLabel: string;
}): string {
  return input.primaryServerVersion &&
    NIGHTLY_SERVER_VERSION_PATTERN.test(input.primaryServerVersion)
    ? "Nightly"
    : input.fallbackStageLabel;
}

export function resolveServerBackedAppDisplayName(input: {
  readonly baseName: string;
  readonly fallbackDisplayName: string;
  readonly fallbackStageLabel: string;
  readonly primaryServerVersion: string | null | undefined;
}): string {
  const stageLabel = resolveServerBackedAppStageLabel({
    primaryServerVersion: input.primaryServerVersion,
    fallbackStageLabel: input.fallbackStageLabel,
  });

  return stageLabel === input.fallbackStageLabel
    ? input.fallbackDisplayName
    : formatAppDisplayName({ baseName: input.baseName, stageLabel });
}
