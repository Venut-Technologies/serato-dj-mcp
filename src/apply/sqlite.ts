/** SQLITE_BUSY is primary result code 5; its extended variants mask down to it in the low byte. */
export function isSqliteBusy(e: unknown): boolean {
  return (((e as { errcode?: number }).errcode ?? -1) & 0xff) === 5;
}
