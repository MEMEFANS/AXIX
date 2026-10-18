// One SQLite commit covers wallet credits, release records, pool metadata and
// team rewards. Share the active unit of work across nested ecosystem services.
const active = new WeakSet();
export function createAixTransaction(database, walletService) {
  return operation => {
    if (active.has(database)) return operation();
    const walletUpdate = walletService.beginAtomicUpdate();
    active.add(database);
    try {
      const result = database.transaction(() => {
        const value = operation();
        if (walletUpdate.isDirty()) {
          // 提交前整库校验一次：替代事务内因批量写入而跳过的逐次 assertState（防 O(N²)）
          walletService.validateState?.();
          database.replaceWalletStateInside(walletUpdate.exportState());
        }
        return value;
      });
      walletUpdate.finish();
      return result;
    } catch (error) {
      walletUpdate.rollback();
      throw error;
    } finally { active.delete(database); }
  };
}
