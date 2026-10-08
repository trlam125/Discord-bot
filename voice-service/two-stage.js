/** Only try the secondary source when primary setup fails. Never retry recursively. */
export async function tryPrimaryThenFallback(primary, secondary, allowFallback) {
  try { return await primary(); }
  catch (error) {
    if (!allowFallback()) throw error;
    return secondary(error);
  }
}
