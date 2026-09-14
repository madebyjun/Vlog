import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useState } from "react";
import { TIER_DESCRIPTIONS, TIER_FOLDERS, Tier } from "../lib/config";
import { Plan } from "../lib/plan";
import { DateGroup } from "../lib/scan";

interface Props {
  group: DateGroup;
  defaultTitle: string;
  initial?: { title: string; tier: Tier };
  onSubmit: (plan: Plan) => void;
}

/** スクリプトの「タイトルを入力」「Select storage tier」に相当 */
export function NewProjectForm({ group, defaultTitle, initial, onSubmit }: Props) {
  const { pop } = useNavigation();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [tier, setTier] = useState<Tier>(initial?.tier ?? "TIER_2__STORE");
  const [titleError, setTitleError] = useState<string | undefined>();

  const effectiveTitle = title.trim() === "" ? defaultTitle : title.trim();

  const submit = () => {
    if (title.includes("/")) {
      setTitleError("タイトルに / は使えません。");
      return;
    }
    onSubmit({ kind: "new", title: effectiveTitle, tier });
    pop();
  };

  return (
    <Form
      navigationTitle={`新規プロジェクト: ${group.date}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="このプランで確定" icon={Icon.Checkmark} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description title="対象" text={`${group.device.name} / ${group.date} (${group.files.length}ファイル)`} />
      <Form.TextField
        id="title"
        title="タイトル"
        placeholder={defaultTitle}
        value={title}
        error={titleError}
        info={`空欄の場合は「${defaultTitle}」になります。/ は使えません。`}
        onChange={(value) => {
          setTitle(value);
          if (titleError && !value.includes("/")) setTitleError(undefined);
        }}
      />
      <Form.Dropdown id="tier" title="保存 Tier" value={tier} onChange={(value) => setTier(value as Tier)}>
        {TIER_FOLDERS.map((t) => (
          <Form.Dropdown.Item key={t} value={t} title={`${t}  -  ${TIER_DESCRIPTIONS[t]}`} />
        ))}
      </Form.Dropdown>
      <Form.Separator />
      <Form.Description title="作成先" text={`${tier}/${group.date}-${effectiveTitle}`} />
      <Form.Description title="" text="同名フォルダがある場合は末尾に -1, -2 … が付きます。" />
    </Form>
  );
}
