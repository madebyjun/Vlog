import { Action, ActionPanel, Form, Icon, Toast, showToast } from "@raycast/api";
import { useForm, usePromise } from "@raycast/utils";
import { useMemo } from "react";
import { TIER_DESCRIPTIONS, TIER_FOLDERS, TIER_LABELS } from "../lib/config";
import { formatGib } from "../lib/format";
import { loadRaycastSettings, raycastSettingsFile, saveRaycastSettings } from "../lib/runtime";
import { FIELD_VALIDATORS, SettingsInput, validateSettings } from "../lib/settings";
import { VolumeInfo, listVolumes } from "../lib/ssd";

interface Props {
  /** 初回セットアップとして表示する */
  onboarding?: boolean;
  onSaved?: () => void;
}

/** 00:00〜11:30 を 30 分刻みで (日付切り替え時刻の候補) */
const CUTOFF_CHOICES = Array.from({ length: 24 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, "0");
  return `${h}:${i % 2 === 0 ? "00" : "30"}`;
});

export function SettingsForm(props: Props) {
  const { data: volumes, isLoading } = usePromise(() => listVolumes());
  // ドロップダウンの選択肢がそろってから描画する (候補に無い値が勝手に置き換わるのを防ぐ)
  if (isLoading || !volumes) return <Form isLoading navigationTitle="設定" />;
  return <SettingsFormBody {...props} volumes={volumes} />;
}

function SettingsFormBody({ onboarding, onSaved, volumes }: Props & { volumes: VolumeInfo[] }) {
  const initialValues = useMemo(() => {
    const loaded = loadRaycastSettings();
    const input = { ...loaded.input };
    // 未設定なら、保存先フォルダがあるボリュームを最初の候補にする
    if (!input.ssdUuid) input.ssdUuid = volumes.find((v) => v.hasFootageRoot)?.uuid ?? "";
    return input;
  }, [volumes]);

  const { handleSubmit, itemProps, values, setValidationError } = useForm<SettingsInput>({
    initialValues,
    validation: {
      ssdUuid: FIELD_VALIDATORS.ssdUuid,
      spaceMarginGb: FIELD_VALIDATORS.spaceMarginGb,
      defaultTitle: FIELD_VALIDATORS.defaultTitle,
      excludePatterns: FIELD_VALIDATORS.excludePatterns,
    },
    onSubmit: async (input) => {
      const { settings, errors } = validateSettings(input);
      if (!settings) {
        for (const [key, message] of Object.entries(errors)) setValidationError(key as keyof SettingsInput, message);
        return;
      }
      try {
        saveRaycastSettings(settings);
      } catch (error) {
        await showToast({
          style: Toast.Style.Failure,
          title: "設定を保存できませんでした",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      await showToast({ style: Toast.Style.Success, title: "設定を保存しました" });
      onSaved?.();
    },
  });

  const selected = volumes.find((v) => v.uuid === values.ssdUuid);
  const cutoffChoices = CUTOFF_CHOICES.includes(initialValues.cutoffTime)
    ? CUTOFF_CHOICES
    : [...CUTOFF_CHOICES, initialValues.cutoffTime].sort();

  return (
    <Form
      navigationTitle={onboarding ? "はじめに" : "設定"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={onboarding ? "保存してスキャン" : "設定を保存"}
            icon={Icon.Checkmark}
            onSubmit={handleSubmit}
          />
          <Action.ShowInFinder title="設定ファイルを表示" path={raycastSettingsFile()} />
        </ActionPanel>
      }
    >
      {onboarding && (
        <Form.Description text="取り込み先のSSDを選んでください。その他の項目はあとから「Configure Vlog Import」で変更できます。" />
      )}
      <Form.Dropdown
        title="保存先SSD"
        info="「001 Camera/Footage」フォルダがあるボリュームが候補として上に表示されます。一覧に無い場合は接続してから開き直してください。"
        {...itemProps.ssdUuid}
      >
        {!volumes.some((v) => v.uuid === initialValues.ssdUuid) && initialValues.ssdUuid && (
          <Form.Dropdown.Item
            value={initialValues.ssdUuid}
            title={`未接続のSSD (${initialValues.ssdUuid.slice(0, 8)}…)`}
            icon={Icon.QuestionMarkCircle}
          />
        )}
        {volumes.map((v) => (
          <Form.Dropdown.Item
            key={v.uuid}
            value={v.uuid}
            title={v.hasFootageRoot ? v.name : `${v.name} (Footage フォルダなし)`}
            icon={v.internal ? Icon.HardDrive : Icon.Monitor}
            keywords={[v.uuid]}
          />
        ))}
      </Form.Dropdown>
      <Form.Description
        title=""
        text={
          selected
            ? `${selected.mount}${selected.freeBytes !== undefined ? ` · 空き ${formatGib(selected.freeBytes)}` : ""}`
            : "このSSDは現在接続されていません"
        }
      />
      <Form.TextField
        title="安全マージン (GB)"
        placeholder="2"
        info="転送予定サイズ + マージンが空き容量を超える場合、転送前に確認します。"
        {...itemProps.spaceMarginGb}
      />

      <Form.Separator />

      <Form.Dropdown
        title="日付の切り替え時刻"
        info="この時刻より前に撮影されたファイルは、前日の撮影として扱います。"
        {...itemProps.cutoffTime}
      >
        {cutoffChoices.map((t) => (
          <Form.Dropdown.Item key={t} value={t} title={t} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        title="除外するファイル"
        placeholder="*.LRF"
        info="カンマ区切りのパターン (* と ? が使えます)。一致するファイルは転送しません。"
        {...itemProps.excludePatterns}
      />

      <Form.Separator />

      <Form.TextField
        title="既定のタイトル"
        placeholder="NewProject"
        info="新規プロジェクトのタイトルを空欄にしたときに使われます。"
        {...itemProps.defaultTitle}
      />
      <Form.Dropdown title="既定の Tier" info="新規プロジェクトの保存先 Tier の初期値です。" {...itemProps.defaultTier}>
        {TIER_FOLDERS.map((t) => (
          <Form.Dropdown.Item key={t} value={t} title={`${TIER_LABELS[t]} — ${TIER_DESCRIPTIONS[t]}`} />
        ))}
      </Form.Dropdown>

      <Form.Separator />

      <Form.Checkbox label="日付ごとの転送が終わったらプロジェクトフォルダを開く" {...itemProps.openInFinder} />
      <Form.Checkbox label="転送が終わったら通知する" {...itemProps.notify} />
    </Form>
  );
}
