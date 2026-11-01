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
          // 提交前校验：事务内只可能改动被 touchUser 标记过的账户（全部经由 ensureUser/addBalance），
          // 只校验触碰集合即可（旧全量校验对 3.5 万用户逐个正则，是 60s 矿机/质押结算的 CPU 尖峰来源）
          const touched = walletUpdate.touchedSummary();
          walletService.validateState?.(touched?.users || null);
          database.replaceWalletStateInside(walletUpdate.exportState(), touched);
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
