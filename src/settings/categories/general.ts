import type { SettingCategory } from "@/types/settings-schema";
import { LOCALES } from "@shared/types/settings";
import StorageManager from "@/components/settings/custom/StorageManager.vue";
import { useUpdateStore } from "@/stores/update";
import IconLucideCog from "~icons/lucide/cog";

const generalCategory: SettingCategory = {
  id: "general",
  icon: IconLucideCog,
  sections: [
    {
      id: "language",
      items: [
        {
          key: "language",
          type: "select",
          binding: { store: "settings", path: "locale" },
          options: LOCALES.map(({ value, label }) => ({ value, label })),
          defaultValue: "zh-CN",
        },
      ],
    },
    {
      id: "systemConfig",
      items: [
        {
          key: "orpheusProtocol",
          type: "switch",
          binding: { store: "settings", path: "system.system.registerOrpheusProtocol" },
          defaultValue: false,
        },
      ],
    },
    {
      id: "update",
      items: [
        {
          key: "updateChannel",
          type: "select",
          binding: { store: "settings", path: "system.update.channel" },
          options: [
            { value: "stable", labelKey: "settings.updateChannel.stable" },
            { value: "beta", labelKey: "settings.updateChannel.beta" },
            { value: "alpha", labelKey: "settings.updateChannel.alpha" },
          ],
          defaultValue: "stable",
          confirm: {
            when: (next) => next === "beta" || next === "alpha",
            titleKey: "settings.confirm.testChannelTitle",
            contentKey: "settings.confirm.testChannelContent",
            type: "warning",
          },
        },
        {
          key: "autoCheckUpdate",
          type: "switch",
          binding: { store: "settings", path: "system.update.autoCheck" },
          defaultValue: true,
        },
        {
          key: "checkUpdate",
          type: "button",
          action: () => useUpdateStore().checkManually(),
        },
      ],
    },
    {
      id: "debug",
      items: [
        {
          key: "showPerformanceMonitor",
          type: "switch",
          binding: { store: "settings", path: "appearance.showPerformanceMonitor" },
          defaultValue: false,
        },
      ],
    },
    {
      id: "backupReset",
      items: [
        {
          key: "storageManager",
          type: "custom",
          component: StorageManager,
          fullWidth: true,
          keywords: ["backup.label", "restore.label", "resetSettings.label", "resetAll.label"],
        },
      ],
    },
  ],
};

export default generalCategory;
