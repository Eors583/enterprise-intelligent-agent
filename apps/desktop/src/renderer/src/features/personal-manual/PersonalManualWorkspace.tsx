import type {
  CollaborationDisclosureScope,
  EmployeeAgentCollaborationSettings,
  MemberSummary,
  PersonalManualContent,
  PersonalManualDisclosurePolicy,
  PersonalManualSection,
  PersonalManualSelfProfile,
} from '@enterprise/contracts';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { ApiClientError } from '../../shared/api/client';
import { getMyPersonalManual, updateMyPersonalManual } from './api';
import { scopeOptions, WorkAvailabilityPanel } from './WorkAvailabilityPanel';
import './personal-manual.css';

type ManualTextField =
  | 'personalSummary'
  | 'educationBackground'
  | 'careerOverview'
  | 'jobResponsibilities'
  | 'communicationPreference'
  | 'collaborationHabits'
  | 'routineSchedule'
  | 'contactInformation'
  | 'coreSkills'
  | 'availableResources'
  | 'hobbies'
  | 'clubs';
type ManualDraft = Record<ManualTextField, string> & {
  faqs: Array<{ id: string; question: string; answer: string }>;
};

const EMPTY_DRAFT: ManualDraft = {
  personalSummary: '',
  educationBackground: '',
  careerOverview: '',
  jobResponsibilities: '',
  communicationPreference: '',
  collaborationHabits: '',
  routineSchedule: '',
  contactInformation: '',
  coreSkills: '',
  availableResources: '',
  hobbies: '',
  clubs: '',
  faqs: [],
};

export function PersonalManualWorkspace({
  members = [],
}: {
  members?: readonly MemberSummary[];
}): React.JSX.Element {
  const [profile, setProfile] = useState<PersonalManualSelfProfile | null>(null);
  const [draft, setDraft] = useState<ManualDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [disclosurePolicy, setDisclosurePolicy] = useState<PersonalManualDisclosurePolicy | null>(
    null,
  );
  const [collaborationSettings, setCollaborationSettings] =
    useState<EmployeeAgentCollaborationSettings | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getMyPersonalManual(controller.signal)
      .then((value) => {
        setProfile(value);
        setDraft(manualToDraft(value.manual));
        setDisclosurePolicy(value.disclosurePolicy);
        setCollaborationSettings(value.collaborationSettings);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(readableError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const manual = useMemo(() => draftToManual(draft), [draft]);
  const dirty =
    profile !== null &&
    disclosurePolicy !== null &&
    collaborationSettings !== null &&
    (JSON.stringify(manual) !== JSON.stringify(profile.manual) ||
      JSON.stringify(disclosurePolicy) !== JSON.stringify(profile.disclosurePolicy) ||
      JSON.stringify(collaborationSettings) !== JSON.stringify(profile.collaborationSettings));
  const completedSections = completionStates(draft).filter((section) => section.complete).length;
  const progress = Math.round((completedSections / 6) * 100);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (
      profile === null ||
      disclosurePolicy === null ||
      collaborationSettings === null ||
      !dirty ||
      saving
    )
      return;
    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      const saved = await updateMyPersonalManual({
        expectedUpdatedAt: profile.updatedAt,
        manual,
        disclosurePolicy,
        collaborationSettings,
      });
      setProfile(saved);
      setDraft(manualToDraft(saved.manual));
      setDisclosurePolicy(saved.disclosurePolicy);
      setCollaborationSettings(saved.collaborationSettings);
      setSavedMessage('个人使用说明书已保存。');
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setSaving(false);
    }
  };

  if (loading && profile === null) {
    return (
      <ManualState title="正在读取个人使用说明书" detail="正在加载你的企业档案和已填写内容。" />
    );
  }
  if (profile === null || disclosurePolicy === null || collaborationSettings === null) {
    return (
      <ManualState
        title="个人使用说明书加载失败"
        detail={error ?? '企业服务暂时不可用。'}
        action={<button onClick={() => setReloadKey((value) => value + 1)}>重新加载</button>}
      />
    );
  }

  return (
    <main className="personal-manual-workspace" aria-labelledby="personal-manual-title">
      <header className="personal-manual-hero">
        <div className="personal-manual-identity">
          <ProfileAvatar profile={profile} />
          <div>
            <p className="eyebrow">HOW TO WORK WITH ME</p>
            <h1 id="personal-manual-title">个人使用说明书</h1>
            <p>让同事快速了解你负责什么、怎样与你协作，以及什么事情适合直接找你。</p>
            <div className="personal-manual-person-tags" aria-label="当前企业档案">
              <span>{profile.user.displayName}</span>
              <span>{profile.employment?.departmentName ?? '暂未分配部门'}</span>
              <span>{profile.employment?.title ?? '暂未设置岗位'}</span>
            </div>
          </div>
        </div>
        <div className="personal-manual-progress" aria-label={`填写完成度 ${progress}%`}>
          <div>
            <span>填写完成度</span>
            <strong>{progress}%</strong>
          </div>
          <progress max="6" value={completedSections} />
          <small>已完成 {completedSections} / 6 个部分，可分多次完善。</small>
        </div>
      </header>

      <div className="personal-manual-notice">
        <strong>填写建议</strong>
        <span>
          用真实、具体的表达即可，不需要写成正式简历。姓名、部门和岗位来自企业档案，在这里仅展示。
        </span>
      </div>

      <section className="personal-manual-sharing" aria-labelledby="personal-manual-sharing-title">
        <div>
          <h2 id="personal-manual-sharing-title">同事通过我的智能体可以了解什么</h2>
          <p>默认仅自己可见。开启后也只会按每个部分的范围和当前工作关系提供必要摘要。</p>
        </div>
        <label className="personal-manual-switch">
          <input
            type="checkbox"
            checked={collaborationSettings.manualSharingEnabled}
            onChange={(event) => updateSettings('manualSharingEnabled', event.target.checked)}
          />
          <span>允许我的智能体介绍我主动公开的内容</span>
        </label>
        <label className="personal-manual-switch">
          <input
            type="checkbox"
            checked={collaborationSettings.availabilitySharingEnabled}
            onChange={(event) => updateSettings('availabilitySharingEnabled', event.target.checked)}
          />
          <span>允许我的智能体分享我设置的工作状态</span>
        </label>
        <label className="personal-manual-switch">
          <input
            type="checkbox"
            checked={collaborationSettings.privateRiskRemindersEnabled}
            onChange={(event) =>
              updateSettings('privateRiskRemindersEnabled', event.target.checked)
            }
          />
          <span>有任务风险时优先私下提醒我</span>
        </label>
      </section>

      <WorkAvailabilityPanel
        currentUserId={profile.user.id}
        members={members}
        sharingEnabled={collaborationSettings.availabilitySharingEnabled}
      />

      {error ? (
        <div className="personal-manual-feedback error" role="alert">
          {error}
          {error.includes('刷新') ? (
            <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
              刷新内容
            </button>
          ) : null}
        </div>
      ) : null}
      {savedMessage ? (
        <div className="personal-manual-feedback success" role="status">
          {savedMessage}
        </div>
      ) : null}

      <form className="personal-manual-form" onSubmit={(event) => void submit(event)}>
        <ManualSection
          number="01"
          title="我是谁？"
          description="用几句话介绍自己，再补充教育和职业经历，帮助同事快速建立基本认识。"
          complete={completionStates(draft)[0]!.complete}
          scope={disclosurePolicy.IDENTITY}
          sharingEnabled={collaborationSettings.manualSharingEnabled}
          onScopeChange={(scope) => updateScope('IDENTITY', scope)}
        >
          <ManualTextarea
            label="个人简介"
            value={draft.personalSummary}
            placeholder="例如：我目前负责企业协作产品，过去主要从事企业服务和 AI 产品设计。"
            onChange={(value) => updateText('personalSummary', value)}
          />
          <div className="personal-manual-two-columns">
            <ManualTextarea
              label="教育背景（可选）"
              value={draft.educationBackground}
              placeholder="毕业院校、专业或重要学习经历。"
              compact
              onChange={(value) => updateText('educationBackground', value)}
            />
            <ManualTextarea
              label="职业经历（可选）"
              value={draft.careerOverview}
              placeholder="简要介绍过去做过的工作和专业方向。"
              compact
              onChange={(value) => updateText('careerOverview', value)}
            />
          </div>
        </ManualSection>

        <ManualSection
          number="02"
          title="我的岗位职责是什么？"
          description="说清楚你目前主要负责的事项、边界和结果；管理者可以补充团队职责。"
          complete={completionStates(draft)[1]!.complete}
          scope={disclosurePolicy.RESPONSIBILITIES}
          sharingEnabled={collaborationSettings.manualSharingEnabled}
          onScopeChange={(scope) => updateScope('RESPONSIBILITIES', scope)}
        >
          <ManualTextarea
            label="岗位职责"
            value={draft.jobResponsibilities}
            placeholder="例如：负责年度产品规划、需求优先级、跨部门协调和版本验收。"
            onChange={(value) => updateText('jobResponsibilities', value)}
          />
        </ManualSection>

        <ManualSection
          number="03"
          title="怎样与我高效协同？"
          description="告诉同事怎样联系你、怎样安排会议，以及哪些习惯能让合作更顺畅。"
          complete={completionStates(draft)[2]!.complete}
          scope={disclosurePolicy.COLLABORATION}
          sharingEnabled={collaborationSettings.manualSharingEnabled}
          onScopeChange={(scope) => updateScope('COLLABORATION', scope)}
        >
          <div className="personal-manual-two-columns">
            <ManualTextarea
              label="沟通偏好"
              value={draft.communicationPreference}
              placeholder="紧急事项、普通问题分别希望通过什么方式沟通？"
              compact
              onChange={(value) => updateText('communicationPreference', value)}
            />
            <ManualTextarea
              label="协作习惯"
              value={draft.collaborationHabits}
              placeholder="会议提前多久预约？希望会前准备哪些材料？"
              compact
              onChange={(value) => updateText('collaborationHabits', value)}
            />
            <ManualTextarea
              label="常规安排"
              value={draft.routineSchedule}
              placeholder="固定会议、专注时段或最适合沟通的时间。"
              compact
              onChange={(value) => updateText('routineSchedule', value)}
            />
            <ManualTextarea
              label="其他联系信息"
              value={draft.contactInformation}
              placeholder="微信、内部账号或其他工作联系方式；不要填写密码。"
              compact
              onChange={(value) => updateText('contactInformation', value)}
            />
          </div>
        </ManualSection>

        <ManualSection
          number="04"
          title="如何用好我？我还能提供哪些资源？"
          description="让同事知道你擅长解决什么问题，以及你愿意共享哪些信息、渠道或资源。"
          complete={completionStates(draft)[3]!.complete}
          scope={disclosurePolicy.RESOURCES}
          sharingEnabled={collaborationSettings.manualSharingEnabled}
          onScopeChange={(scope) => updateScope('RESOURCES', scope)}
        >
          <div className="personal-manual-two-columns">
            <ManualTextarea
              label="核心技能"
              value={draft.coreSkills}
              placeholder="例如：产品规划、复杂需求拆解、企业知识库设计。"
              onChange={(value) => updateText('coreSkills', value)}
            />
            <ManualTextarea
              label="可提供资源"
              value={draft.availableResources}
              placeholder="例如：行业资料、合作渠道、专家网络或成熟模板。"
              onChange={(value) => updateText('availableResources', value)}
            />
          </div>
        </ManualSection>

        <ManualSection
          number="05"
          title="我有哪些兴趣爱好？"
          description="分享工作以外的你，让同事更容易找到共同话题。"
          complete={completionStates(draft)[4]!.complete}
          scope={disclosurePolicy.INTERESTS}
          sharingEnabled={collaborationSettings.manualSharingEnabled}
          onScopeChange={(scope) => updateScope('INTERESTS', scope)}
        >
          <div className="personal-manual-two-columns">
            <ManualTextarea
              label="兴趣爱好"
              value={draft.hobbies}
              placeholder="读书、露营、运动、宠物、剧本杀等。"
              compact
              onChange={(value) => updateText('hobbies', value)}
            />
            <ManualTextarea
              label="参加的社团（可选）"
              value={draft.clubs}
              placeholder="企业内部或社会上的社团、社区和志愿组织。"
              compact
              onChange={(value) => updateText('clubs', value)}
            />
          </div>
        </ManualSection>

        <ManualSection
          number="06"
          title="您可能会问这些问题"
          description="提前回答同事最常问的问题，可以减少重复沟通。问题和答案必须同时填写。"
          complete={completionStates(draft)[5]!.complete}
          scope={disclosurePolicy.FAQ}
          sharingEnabled={collaborationSettings.manualSharingEnabled}
          onScopeChange={(scope) => updateScope('FAQ', scope)}
          action={
            <button
              type="button"
              className="personal-manual-secondary-button"
              disabled={draft.faqs.length >= 20}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  faqs: [...current.faqs, { id: crypto.randomUUID(), question: '', answer: '' }],
                }))
              }
            >
              + 添加一个问题
            </button>
          }
        >
          {draft.faqs.length === 0 ? (
            <div className="personal-manual-empty-faq">
              <strong>还没有常见问题</strong>
              <span>可以从“什么事情适合找我”“找我前要准备什么”开始。</span>
            </div>
          ) : (
            <div className="personal-manual-faq-list">
              {draft.faqs.map((faq, index) => (
                <article key={faq.id} className="personal-manual-faq-item">
                  <div className="personal-manual-faq-number">Q{index + 1}</div>
                  <label>
                    <span>问题</span>
                    <input
                      required
                      maxLength={500}
                      value={faq.question}
                      placeholder="例如：什么事情适合直接找我？"
                      onChange={(event) => updateFaq(faq.id, 'question', event.target.value)}
                    />
                  </label>
                  <label>
                    <span>回答</span>
                    <textarea
                      required
                      maxLength={5_000}
                      value={faq.answer}
                      placeholder="给出明确、可执行的回答。"
                      onChange={(event) => updateFaq(faq.id, 'answer', event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="personal-manual-remove-button"
                    aria-label={`删除问题 ${index + 1}`}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        faqs: current.faqs.filter((item) => item.id !== faq.id),
                      }))
                    }
                  >
                    删除
                  </button>
                </article>
              ))}
            </div>
          )}
        </ManualSection>

        <footer className="personal-manual-save-bar">
          <div>
            <strong>{dirty ? '有尚未保存的修改' : '当前内容已保存'}</strong>
            <span>
              {profile.updatedAt
                ? `最近保存：${new Date(profile.updatedAt).toLocaleString('zh-CN')}`
                : '还没有保存过个人使用说明书。'}
            </span>
          </div>
          <button type="submit" className="primary-button" disabled={!dirty || saving}>
            {saving ? '正在保存…' : '保存说明书'}
          </button>
        </footer>
      </form>
    </main>
  );

  function updateText(field: ManualTextField, value: string): void {
    setSavedMessage(null);
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateFaq(id: string, field: 'question' | 'answer', value: string): void {
    setSavedMessage(null);
    setDraft((current) => ({
      ...current,
      faqs: current.faqs.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    }));
  }

  function updateScope(section: PersonalManualSection, scope: CollaborationDisclosureScope): void {
    setSavedMessage(null);
    setDisclosurePolicy((current) =>
      current === null ? current : { ...current, [section]: scope },
    );
  }

  function updateSettings(field: keyof EmployeeAgentCollaborationSettings, value: boolean): void {
    setSavedMessage(null);
    setCollaborationSettings((current) =>
      current === null ? current : { ...current, [field]: value },
    );
  }
}

function ManualSection({
  number,
  title,
  description,
  complete,
  scope,
  sharingEnabled,
  onScopeChange,
  action,
  children,
}: {
  number: string;
  title: string;
  description: string;
  complete: boolean;
  scope: CollaborationDisclosureScope;
  sharingEnabled: boolean;
  onScopeChange: (scope: CollaborationDisclosureScope) => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="personal-manual-section">
      <header>
        <span className="personal-manual-section-number">{number}</span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span
          className={complete ? 'personal-manual-complete complete' : 'personal-manual-complete'}
        >
          {complete ? '已填写' : '待完善'}
        </span>
        <label className="personal-manual-scope">
          <span>可见范围</span>
          <select
            value={scope}
            disabled={!sharingEnabled}
            onChange={(event) => onScopeChange(event.target.value as CollaborationDisclosureScope)}
          >
            {scopeOptions()}
          </select>
        </label>
        {action}
      </header>
      <div className="personal-manual-section-body">{children}</div>
    </section>
  );
}

function ManualTextarea({
  label,
  value,
  placeholder,
  compact = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  compact?: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="personal-manual-field">
      <span>{label}</span>
      <textarea
        className={compact ? 'compact' : undefined}
        maxLength={5_000}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>{value.length.toLocaleString('zh-CN')} / 5,000</small>
    </label>
  );
}

function ProfileAvatar({ profile }: { profile: PersonalManualSelfProfile }): React.JSX.Element {
  const [imageLoaded, setImageLoaded] = useState(false);

  useEffect(() => setImageLoaded(false), [profile.user.avatarUrl]);

  return (
    <span className="personal-manual-avatar fallback" aria-hidden="true">
      <span className="personal-manual-avatar-initials">
        {[...profile.user.displayName].slice(-2).join('')}
      </span>
      {profile.user.avatarUrl && (
        <img
          className={
            imageLoaded ? 'personal-manual-avatar-image loaded' : 'personal-manual-avatar-image'
          }
          src={profile.user.avatarUrl}
          alt=""
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageLoaded(false)}
        />
      )}
    </span>
  );
}

function ManualState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="personal-manual-workspace state" role="status">
      <h1>{title}</h1>
      <p>{detail}</p>
      {action}
    </main>
  );
}

function manualToDraft(manual: PersonalManualContent): ManualDraft {
  return {
    personalSummary: manual.personalSummary ?? '',
    educationBackground: manual.educationBackground ?? '',
    careerOverview: manual.careerOverview ?? '',
    jobResponsibilities: manual.jobResponsibilities ?? '',
    communicationPreference: manual.communicationPreference ?? '',
    collaborationHabits: manual.collaborationHabits ?? '',
    routineSchedule: manual.routineSchedule ?? '',
    contactInformation: manual.contactInformation ?? '',
    coreSkills: manual.coreSkills ?? '',
    availableResources: manual.availableResources ?? '',
    hobbies: manual.hobbies ?? '',
    clubs: manual.clubs ?? '',
    faqs: manual.faqs.map((faq) => ({ id: crypto.randomUUID(), ...faq })),
  };
}

function draftToManual(draft: ManualDraft): PersonalManualContent {
  return {
    personalSummary: nullable(draft.personalSummary),
    educationBackground: nullable(draft.educationBackground),
    careerOverview: nullable(draft.careerOverview),
    jobResponsibilities: nullable(draft.jobResponsibilities),
    communicationPreference: nullable(draft.communicationPreference),
    collaborationHabits: nullable(draft.collaborationHabits),
    routineSchedule: nullable(draft.routineSchedule),
    contactInformation: nullable(draft.contactInformation),
    coreSkills: nullable(draft.coreSkills),
    availableResources: nullable(draft.availableResources),
    hobbies: nullable(draft.hobbies),
    clubs: nullable(draft.clubs),
    faqs: draft.faqs.map(({ question, answer }) => ({
      question: question.trim(),
      answer: answer.trim(),
    })),
  };
}

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function completionStates(draft: ManualDraft): Array<{ complete: boolean }> {
  const filled = (value: string): boolean => value.trim().length > 0;
  return [
    {
      complete:
        filled(draft.personalSummary) ||
        filled(draft.educationBackground) ||
        filled(draft.careerOverview),
    },
    { complete: filled(draft.jobResponsibilities) },
    {
      complete: [
        draft.communicationPreference,
        draft.collaborationHabits,
        draft.routineSchedule,
        draft.contactInformation,
      ].some(filled),
    },
    { complete: [draft.coreSkills, draft.availableResources].some(filled) },
    { complete: [draft.hobbies, draft.clubs].some(filled) },
    {
      complete:
        draft.faqs.length > 0 &&
        draft.faqs.every((faq) => filled(faq.question) && filled(faq.answer)),
    },
  ];
}

function readableError(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return error instanceof Error ? error.message : '企业服务暂时不可用，请稍后重试。';
}
