import { Action, ActionPanel, Color, Icon, List, popToRoot } from "@raycast/api";
import { TIER_LABELS, Tier } from "../lib/config";
import { Plan } from "../lib/plan";
import { DateGroup } from "../lib/scan";
import { NewProjectForm } from "./NewProjectForm";

interface Props {
  group: DateGroup;
  plan: Plan | undefined;
  defaultTitle: string;
  defaultTier: Tier;
  onChange: (plan: Plan) => void;
}

const CURRENT = { icon: { source: Icon.Checkmark, tintColor: Color.Green }, tooltip: "現在の選択" };

/** 日付ごとの転送先を選ぶ画面 (Enter で開く) */
export function DestinationPicker({ group, plan, defaultTitle, defaultTier, onChange }: Props) {
  const choose = (next: Plan) => {
    onChange(next);
    void popToRoot();
  };

  return (
    <List navigationTitle={`${group.date} の転送先`} searchBarPlaceholder="プロジェクトを検索">
      {group.existing.length > 0 && (
        <List.Section title="既存のプロジェクト">
          {group.existing.map((p) => (
            <List.Item
              key={p.path}
              title={p.name}
              icon={{ source: Icon.Folder, tintColor: Color.Blue }}
              accessories={[
                ...(plan?.kind === "existing" && plan.projectDir === p.path ? [CURRENT] : []),
                { tag: TIER_LABELS[p.tier] },
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title="このプロジェクトに転送"
                    icon={Icon.Folder}
                    onAction={() => choose({ kind: "existing", projectDir: p.path, projectName: p.name })}
                  />
                  <Action.ShowInFinder path={p.path} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      <List.Section title="その他">
        <List.Item
          title="新規プロジェクトを作成…"
          subtitle={plan?.kind === "new" ? `${TIER_LABELS[plan.tier]} / ${plan.title}` : undefined}
          icon={{ source: Icon.NewFolder, tintColor: Color.Green }}
          accessories={plan?.kind === "new" ? [CURRENT] : []}
          actions={
            <ActionPanel>
              <Action.Push
                title="新規プロジェクトを作成…"
                icon={Icon.NewFolder}
                target={
                  <NewProjectForm
                    group={group}
                    defaultTitle={defaultTitle}
                    defaultTier={defaultTier}
                    initial={plan?.kind === "new" ? { title: plan.title, tier: plan.tier } : undefined}
                    onSubmit={onChange}
                  />
                }
              />
            </ActionPanel>
          }
        />
        <List.Item
          title="今回はスキップ"
          subtitle="履歴に残らないので、次回また転送対象になります"
          icon={{ source: Icon.MinusCircle, tintColor: Color.SecondaryText }}
          accessories={plan?.kind === "skip" ? [CURRENT] : []}
          actions={
            <ActionPanel>
              <Action title="スキップ" icon={Icon.MinusCircle} onAction={() => choose({ kind: "skip" })} />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}
