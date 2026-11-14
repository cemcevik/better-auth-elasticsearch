import { headers } from "next/headers";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { AuthForm } from "./auth-form";
import { buttonClass } from "./styles";

export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 p-4 dark:bg-black">
      <main className="flex w-full max-w-md flex-col gap-6 rounded-2xl bg-white p-8 sm:p-10 dark:bg-zinc-900">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Better Auth on Elasticsearch
          </h1>
          <p className="text-sm text-zinc-500">
            Users, accounts and sessions are stored through{" "}
            <code className="font-mono">better-auth-elasticsearch</code>.
          </p>
        </header>
        <Suspense fallback={<p className="text-zinc-500">Loading…</p>}>
          <CurrentUser />
        </Suspense>
      </main>
    </div>
  );
}

async function CurrentUser() {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) return <AuthForm />;

  const { user, session } = result;
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">Name</dt>
        <dd>{user.name}</dd>
        <dt className="text-zinc-500">Email</dt>
        <dd>{user.email}</dd>
        <dt className="text-zinc-500">Company</dt>
        <dd>{user.company || "—"}</dd>
        <dt className="text-zinc-500">User id</dt>
        <dd className="break-all">{user.id}</dd>
        <dt className="text-zinc-500">Session expires</dt>
        <dd>{session.expiresAt.toLocaleString("en")}</dd>
      </dl>
      <form
        action={async () => {
          "use server";
          await auth.api.signOut({ headers: await headers() });
        }}
      >
        <button type="submit" className={`${buttonClass} w-full`}>
          Sign out
        </button>
      </form>
    </>
  );
}
