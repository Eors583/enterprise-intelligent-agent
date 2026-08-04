import type { Objective, Task } from '@enterprise/contracts';

import { formatWorkbenchDate, taskStatusLabel } from '../workbench/workbench-view';

interface EmployeeWorkbenchOverviewProps {
  userName: string;
  objectives: readonly Objective[];
  tasks: readonly Task[];
  loading: boolean;
  onSelectTask: (taskId: string) => void;
  onAskAgent: () => void;
}

const OPEN_TASK_STATUSES = new Set<Task['status']>(['PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED']);

export function EmployeeWorkbenchOverview({
  userName,
  objectives,
  tasks,
  loading,
  onSelectTask,
  onAskAgent,
}: EmployeeWorkbenchOverviewProps): React.JSX.Element {
  const now = Date.now();
  const sevenDaysLater = now + 7 * 24 * 60 * 60 * 1000;
  const openTasks = tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  const dueSoon = openTasks
    .filter((task) => {
      const dueAt = Date.parse(task.dueAt);
      return Number.isFinite(dueAt) && dueAt >= now && dueAt <= sevenDaysLater;
    })
    .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
  const collaboration = openTasks
    .filter((task) => task.status === 'IN_PROGRESS' || task.status === 'BLOCKED')
    .slice(0, 4);
  const recentDelivery = tasks
    .filter((task) => task.status === 'DELIVERED' || task.status === 'ACCEPTED')
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 4);

  return (
    <div className="employee-workbench-overview">
      <section className="content-card employee-workbench-welcome">
        <div>
          <p className="eyebrow">MY WORKBENCH</p>
          <h1>{userName}，今天从这里开始</h1>
          <p>目标、待办和交付均来自当前账号经服务端授权的真实业务数据。</p>
        </div>
        <button type="button" onClick={onAskAgent}>
          <span>AI</span>
          询问智能体
        </button>
      </section>
      <section className="employee-workbench-metrics" aria-label="我的工作概况">
        <Metric
          label="我的目标"
          value={objectives.filter((item) => item.status === 'ACTIVE').length}
        />
        <Metric label="待办任务" value={openTasks.length} />
        <Metric label="即将到期" value={dueSoon.length} />
        <Metric label="最近交付" value={recentDelivery.length} />
      </section>
      {loading && tasks.length === 0 ? (
        <div className="employee-workbench-loading" role="status">
          正在读取工作台数据…
        </div>
      ) : (
        <section className="employee-workbench-lists">
          <TaskList
            title="待办与即将到期"
            empty="当前没有待办任务。"
            tasks={[...dueSoon, ...openTasks.filter((task) => !dueSoon.includes(task))].slice(0, 5)}
            onSelect={onSelectTask}
          />
          <TaskList
            title="协作事项"
            empty="当前没有进行中或阻塞的协作事项。"
            tasks={collaboration}
            onSelect={onSelectTask}
          />
          <TaskList
            title="最近交付"
            empty="当前授权范围内暂无最近交付。"
            tasks={recentDelivery}
            onSelect={onSelectTask}
          />
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function TaskList({
  title,
  empty,
  tasks,
  onSelect,
}: {
  title: string;
  empty: string;
  tasks: readonly Task[];
  onSelect: (taskId: string) => void;
}): React.JSX.Element {
  return (
    <article className="content-card employee-workbench-list">
      <header>
        <h2>{title}</h2>
        <span>{tasks.length}</span>
      </header>
      {tasks.length === 0 ? (
        <p>{empty}</p>
      ) : (
        tasks.map((task) => (
          <button type="button" key={task.id} onClick={() => onSelect(task.id)}>
            <span className={`task-state-mark ${task.status.toLowerCase()}`}>任</span>
            <span>
              <strong>{task.title}</strong>
              <small>
                {taskStatusLabel(task.status)} · 截止 {formatWorkbenchDate(task.dueAt)}
              </small>
            </span>
          </button>
        ))
      )}
    </article>
  );
}
