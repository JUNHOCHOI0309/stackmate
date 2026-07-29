export type GameMode = 'single' | 'multiplayer';

export type PlayerProfile = {
  draws: number;
  losses: number;
  rating: number;
  wins: number;
};

export type Settlement = {
  currentRating: number;
  delta: number;
  previousRating: number;
};

const PROFILE_KEY = 'stackmate.profile.v1';
const DEFAULT_PROFILE: PlayerProfile = { draws: 0, losses: 0, rating: 1200, wins: 0 };

export function loadProfile(): PlayerProfile {
  try {
    const stored = localStorage.getItem(PROFILE_KEY);
    return stored === null ? { ...DEFAULT_PROFILE } : { ...DEFAULT_PROFILE, ...JSON.parse(stored) };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export function settleProfile(result: 'win' | 'loss' | 'draw', opponentRating = 1200): Settlement {
  const profile = loadProfile();
  const previousRating = profile.rating;
  const expectedScore = 1 / (1 + 10 ** ((opponentRating - previousRating) / 400));
  const score = result === 'win' ? 1 : result === 'loss' ? 0 : 0.5;
  const delta = Math.round(32 * (score - expectedScore));
  profile.rating = Math.max(100, previousRating + delta);
  if (result === 'win') profile.wins += 1;
  if (result === 'loss') profile.losses += 1;
  if (result === 'draw') profile.draws += 1;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  return { currentRating: profile.rating, delta, previousRating };
}
