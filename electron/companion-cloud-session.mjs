/** The Seira Cloud session the app already holds, as `{ accountToken, user }` or null. Phone access borrows it and never revokes it. */
export function createSharedSession(source) {
  const current = () => {
    try {
      return source?.current() ?? null;
    } catch {
      return null;
    }
  };
  return Object.freeze({
    current,
    owns: (token) => current()?.accountToken === token,
    tokenFor: (account) => {
      const session = current();
      return session?.user.id === account.userId ? session.accountToken : account.accountToken;
    },
  });
}
