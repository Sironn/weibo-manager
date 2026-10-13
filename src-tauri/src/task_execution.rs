use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// 下载和删除任务共用一个执行名额，默认同时只运行一个任务。
pub struct TaskExecutionGate {
    semaphore: Arc<Semaphore>,
}

impl Default for TaskExecutionGate {
    fn default() -> Self {
        Self { semaphore: Arc::new(Semaphore::new(1)) }
    }
}

impl TaskExecutionGate {
    pub async fn acquire(&self) -> Result<OwnedSemaphorePermit, String> {
        self.semaphore.clone().acquire_owned().await
            .map_err(|_| "任务执行名额不可用，请重启应用后重试。".to_string())
    }
}
