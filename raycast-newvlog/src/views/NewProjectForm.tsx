import { Action, ActionPanel, Form, Icon, popToRoot } from "@raycast/api";
import { useState } from "react";
import { TIER_DESCRIPTIONS, TIER_FOLDERS, TIER_LABELS, Tier } from "../lib/config";
import { Plan } from "../lib/plan";
import { DateGroup } from "../lib/scan";

interface Props {
  group: DateGroup;
  defaultTitle: string;
  defaultTier: Tier;
  initial?: { title: string; tier: Tier };
  onSubmit: (plan: Plan) => void;
}

/** スクリプトの「タイトルを入力」「Select storage tier」に相当 */
export function NewProjectForm({ group, defaultTitle, defaultTier, initial, onSubmit }: Props) {
  // 既定タイトルのままなら空欄から始める (placeholder で既定値を見せる)
  const [title, setTitle] = useState(initial && initial.title !== defaultTitle ? initial.title : "");
  const [tier, setTier] = useState<Tier>(initial?.tier ?? defaultTier);
  const [titleError, setTitleError] = useState<string | undefined>();

  const effectiveTitle = title.trim() === "" ? defaultTitle : title.trim();

  const submit = () => {
    if (title.includes("/")) {
      setTitleError("/ は使えません");
      return;
    }
    onSubmit({ kind: "new", title: effectiveTitle, tier });
    void popToRoot();
  };

  return (
    <Form
      navigationTitle={`${group.date} の新規プロジェクト`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="決定" icon={Icon.Checkmark} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description title="対象" text={`${group.date} · ${group.device.name} · ${group.files.length}ファイル`} />
      <Form.TextField
        id="title"
        title="タイトル"
        placeholder={defaultTitle}
        value={title}
        error={titleError}
        info={`空欄なら「${defaultTitle}」になります。`}
        autoFocus
        onChange={(value) => {
          setTitle(value);
          if (titleError && !value.includes("/")) setTitleError(undefined);
        }}
      />
      <Form.Dropdown id="tier" title="Tier" value={tier} onChange={(value) => setTier(value as Tier)}>
        {TIER_FOLDERS.map((t) => (
          <Form.Dropdown.Item key={t} value={t} title={`${TIER_LABELS[t]} — ${TIER_DESCRIPTIONS[t]}`} />
        ))}
      </Form.Dropdown>
      <Form.Separator />
      <Form.Description
        title="作成先"
        text={`${tier}/${group.date}-${effectiveTitle}\n同名のフォルダがあれば末尾に -1, -2 … が付きます。`}
      />
    </Form>
  );
}
