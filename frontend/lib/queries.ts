"use client";

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import type {
  ConfigEntry,
  Department,
  DirectoryUser,
  DocumentDetail,
  DocumentFile,
  DocumentListItem,
  DocumentType,
  MyAction,
  MyTask,
  NotificationItem,
  Page,
  Position,
  PreviewStage,
  Profile,
  RoleInfo,
  VersionInfo
} from "@/lib/types";

export function useProfile() {
  return useQuery({ queryKey: ["me"], queryFn: () => apiRequest<Profile>("/auth/me"), retry: false, staleTime: 60_000 });
}

/** Profil w komponentach pod bramką logowania: tam zawsze jest już wczytany. */
export function useMe() {
  const { data } = useProfile();
  return data as Profile;
}

export function useMyTasks() {
  return useQuery({ queryKey: ["tasks"], queryFn: () => apiRequest<MyTask[]>("/workflow/tasks/my"), refetchInterval: 60_000 });
}

export type DocumentFilters = { scope?: string; status?: string; typeId?: string; search?: string };

function documentsPath(filters: DocumentFilters, cursor: string | null, limit: number) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.status) params.set("status", filters.status);
  if (filters.typeId) params.set("typeId", filters.typeId);
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  if (cursor) params.set("cursor", cursor);
  return `/documents?${params}`;
}

/** Lista z paginacją po stronie serwera: szukanie obejmuje wszystkie dokumenty, nie pierwszą stronę. */
export function useDocuments(filters: DocumentFilters, limit = 25) {
  const query = useInfiniteQuery({
    queryKey: ["documents", filters, limit],
    queryFn: ({ pageParam }) => apiRequest<Page<DocumentListItem>>(documentsPath(filters, pageParam, limit)),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.pageInfo.nextCursor
  });
  return {
    ...query,
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    total: query.data?.pages[0]?.pageInfo.total ?? 0
  };
}

/** Osobista historia: to, co zrobiłem sam, a nie to, co zrobiła moja rola. */
export function useMyActions(limit = 25) {
  const query = useInfiniteQuery({
    queryKey: ["my-actions", limit],
    queryFn: ({ pageParam }) => apiRequest<Page<MyAction>>(`/workflow/actions/my?limit=${limit}${pageParam ? `&cursor=${pageParam}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.pageInfo.nextCursor
  });
  return { ...query, items: query.data?.pages.flatMap((page) => page.items) ?? [] };
}

export function useDocument(id: string) {
  return useQuery({
    queryKey: ["document", id],
    queryFn: () => apiRequest<DocumentDetail>(`/documents/${id}`),
    // Skan antywirusowy trwa w tle: odświeżamy, dopóki jakiś plik na niego czeka.
    refetchInterval: (query) => (query.state.data?.files.some((file: DocumentFile) => file.scanStatus === "PENDING") ? 3_000 : false)
  });
}

export function useWorkflowPreview(id: string, enabled: boolean, version?: number) {
  return useQuery({
    queryKey: ["workflow-preview", id, version],
    queryFn: () => apiRequest<{ stages: PreviewStage[] }>(`/documents/${id}/workflow-preview`),
    enabled,
    retry: false
  });
}

export function useDocumentTypes() {
  return useQuery({ queryKey: ["document-types"], queryFn: () => apiRequest<DocumentType[]>("/document-types"), staleTime: 60_000 });
}

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => apiRequest<DirectoryUser[]>("/users"), staleTime: 30_000 });
}

export function useDepartments() {
  return useQuery({ queryKey: ["departments"], queryFn: () => apiRequest<Department[]>("/organization/departments"), staleTime: 30_000 });
}

export function usePositions() {
  return useQuery({ queryKey: ["positions"], queryFn: () => apiRequest<Position[]>("/organization/positions"), staleTime: 300_000 });
}

export function useRoles() {
  return useQuery({ queryKey: ["roles"], queryFn: () => apiRequest<RoleInfo[]>("/users/roles"), staleTime: 300_000 });
}

export function useConfigEntries() {
  return useQuery({ queryKey: ["config"], queryFn: () => apiRequest<ConfigEntry[]>("/config") });
}

/** Raz na sesję: wersja zmienia się tylko przy instalacji, a pigułkę „Nowa wersja” chowa timer. */
export function useVersionInfo() {
  return useQuery({ queryKey: ["version"], queryFn: () => apiRequest<VersionInfo>("/config/version"), staleTime: Infinity, retry: false });
}

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => apiRequest<{ items: NotificationItem[]; unreadCount: number }>("/notifications"),
    refetchInterval: 30_000
  });
}

/** Po każdej zmianie dokumentu: odświeża wszystko, co mogło się przez nią zmienić. */
export function useInvalidateWork() {
  const client = useQueryClient();
  return () => Promise.all([
    client.invalidateQueries({ queryKey: ["documents"] }),
    client.invalidateQueries({ queryKey: ["document"] }),
    client.invalidateQueries({ queryKey: ["workflow-preview"] }),
    client.invalidateQueries({ queryKey: ["tasks"] }),
    client.invalidateQueries({ queryKey: ["my-actions"] }),
    client.invalidateQueries({ queryKey: ["notifications"] })
  ]);
}
