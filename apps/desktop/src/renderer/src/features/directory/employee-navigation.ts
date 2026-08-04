import type { NavigationItem } from '@enterprise/contracts';

export type EmployeeSection = 'workbench' | 'messages' | 'directory' | 'my';

export interface EmployeeNavigationItem {
  readonly id: EmployeeSection;
  readonly label: string;
}

const WORKBENCH_IDS = new Set([
  'home',
  'overview',
  'dashboard',
  'workbench',
  'objective-tasks',
  'objectives-tasks',
  'objectives',
  'goals',
]);
const MESSAGE_IDS = new Set([
  'messages',
  'messaging',
  'conversations',
  'chat',
  'agents',
  'agent-center',
  'assistants',
]);
const DIRECTORY_IDS = new Set(['directory', 'contacts', 'organization', 'org']);
const MY_IDS = new Set([
  'my',
  'profile',
  'account',
  'roles',
  'my-roles',
  'role-workspace',
  'growth',
  'people',
  'development',
  'my-growth',
  'memories',
  'memory',
  'my-memory',
  'experience-usage',
  'experiences',
  'my-experiences',
  'ai-usage',
]);

const PRIMARY_NAVIGATION: readonly EmployeeNavigationItem[] = [
  { id: 'workbench', label: '工作台' },
  { id: 'messages', label: '消息' },
  { id: 'directory', label: '通讯录' },
  { id: 'my', label: '我的' },
];

export function employeeSectionForLegacyId(id: string): EmployeeSection | null {
  const normalized = id.trim().replace(/^#/, '').toLocaleLowerCase('en-US');
  if (WORKBENCH_IDS.has(normalized)) return 'workbench';
  if (MESSAGE_IDS.has(normalized)) return 'messages';
  if (DIRECTORY_IDS.has(normalized)) return 'directory';
  if (MY_IDS.has(normalized)) return 'my';
  return null;
}

export function buildEmployeeNavigation(
  serverNavigation: readonly NavigationItem[],
): EmployeeNavigationItem[] {
  const allowed = new Set<EmployeeSection>();
  for (const item of serverNavigation) {
    const section = employeeSectionForLegacyId(item.id);
    if (section) allowed.add(section);
  }

  // Account and security self-service is available to every authenticated user,
  // even when an older API bootstrap did not publish a dedicated navigation item.
  allowed.add('my');
  return PRIMARY_NAVIGATION.filter((item) => allowed.has(item.id));
}

export function initialEmployeeSection(
  hash: string,
  navigation: readonly EmployeeNavigationItem[],
): EmployeeSection {
  const requested = employeeSectionForLegacyId(hash);
  if (requested && navigation.some((item) => item.id === requested)) return requested;
  return navigation.find((item) => item.id === 'workbench')?.id ?? navigation[0]?.id ?? 'my';
}
