import { create } from 'zustand';
import type { ProfileItem } from '../../shared/types';

interface ProfileStore {
  subscriptions: ProfileItem[];
  activeSubscriptionId: string;
  isUpdatingAll: boolean;

  // Actions
  setSubscriptions: (subs: ProfileItem[]) => void;
  setActiveSubscription: (id: string) => void;
  toggleSubscriptionEnabled: (id: string) => Promise<void>;
  updateSubscription: (id: string) => Promise<void>;
  updateAllSubscriptions: () => Promise<void>;
  addSubscription: (sub: Omit<ProfileItem, 'id' | 'updatedAt' | 'status' | 'nodeCount'>) => Promise<string>;
  deleteSubscription: (id: string) => Promise<void>;
}

export const useProfileStore = create<ProfileStore>((set, get) => ({
  subscriptions: [],
  activeSubscriptionId: '',
  isUpdatingAll: false,

  setSubscriptions: (subs) => set({ subscriptions: subs }),

  setActiveSubscription: (id: string) => {
    set((state) => ({
      activeSubscriptionId: id,
      subscriptions: state.subscriptions.map((s) => ({
        ...s,
        active: s.id === id,
      })),
    }));
    if (window.nexlinkAPI?.storage) {
      window.nexlinkAPI.storage.saveState({ activeSubscriptionId: id }).catch(console.error);
    }
  },

  toggleSubscriptionEnabled: async (id: string) => {
    if (window.nexlinkAPI?.subscriptions) {
      await window.nexlinkAPI.subscriptions.toggle(id);
    } else {
      set((state) => ({
        subscriptions: state.subscriptions.map((s) =>
          s.id === id ? { ...s, enabled: !s.enabled } : s
        ),
      }));
    }
  },

  updateSubscription: async (id) => {
    set((state) => ({
      subscriptions: state.subscriptions.map((s) =>
        s.id === id ? { ...s, status: 'updating' as const } : s
      ),
    }));

    try {
      if (window.nexlinkAPI?.subscriptions) {
        const res = await window.nexlinkAPI.subscriptions.update(id);
        if (res && res.success === false) {
          set((state) => ({
            subscriptions: state.subscriptions.map((s) =>
              s.id === id ? { ...s, status: 'error' as const, errorMessage: res.error || '更新失败' } : s
            ),
          }));
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 600));
        set((state) => ({
          subscriptions: state.subscriptions.map((s) =>
            s.id === id ? { ...s, status: 'ok' as const, updatedAt: '刚刚' } : s
          ),
        }));
      }
    } catch (err: any) {
      set((state) => ({
        subscriptions: state.subscriptions.map((s) =>
          s.id === id ? { ...s, status: 'error' as const, errorMessage: err?.message || '更新异常' } : s
        ),
      }));
    }
  },

  updateAllSubscriptions: async () => {
    if (get().isUpdatingAll) return;
    set({ isUpdatingAll: true });
    try {
      if (window.nexlinkAPI?.subscriptions) {
        await window.nexlinkAPI.subscriptions.updateAll();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    } catch (err) {
      console.error('批量更新订阅失败:', err);
    } finally {
      set({ isUpdatingAll: false });
    }
  },

  addSubscription: async (newSub) => {
    if (window.nexlinkAPI?.subscriptions) {
      const created = await window.nexlinkAPI.subscriptions.add(newSub);
      return created.id;
    }

    const id = `sub-${Date.now()}`;
    const item: ProfileItem = {
      ...newSub,
      id,
      nodeCount: 0,
      updatedAt: '从未更新',
      status: 'ok',
      enabled: true,
      active: false,
    };
    set((state) => ({
      subscriptions: [item, ...state.subscriptions],
    }));
    return id;
  },

  deleteSubscription: async (id) => {
    if (window.nexlinkAPI?.subscriptions) {
      await window.nexlinkAPI.subscriptions.delete(id);
    } else {
      set((state) => ({
        subscriptions: state.subscriptions.filter((s) => s.id !== id),
      }));
    }
  },
}));
