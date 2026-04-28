import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const defaultQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function FounderQueryProvider({
  children,
  client = defaultQueryClient,
}: {
  children: React.ReactNode;
  client?: QueryClient;
}) {
  return (
    <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>
  );
}

export { defaultQueryClient as queryClient };
