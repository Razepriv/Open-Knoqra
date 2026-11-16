export type ProfilePart = 'name' | 'timezone';

const PART_LABEL: Record<ProfilePart, string> = { name: 'name', timezone: 'time zone' };

/** Saving the profile is two requests, so a failure must say which part did not go through. */
export class ProfileSaveError extends Error {
  readonly failed: ProfilePart;
  readonly nameSaved: boolean;

  constructor(failed: ProfilePart, nameSaved: boolean) {
    super(profileSaveErrorMessage(failed, nameSaved));
    this.name = 'ProfileSaveError';
    this.failed = failed;
    this.nameSaved = nameSaved;
  }
}

export function profileSaveErrorMessage(failed: ProfilePart, nameSaved: boolean): string {
  if (failed === 'timezone' && nameSaved) {
    return "Your name was saved, but we couldn't save your time zone. Try again.";
  }
  return `We couldn't save your ${PART_LABEL[failed]}. Nothing was changed.`;
}
