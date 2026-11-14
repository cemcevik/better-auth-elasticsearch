"use client";

import { useRouter } from "next/navigation";
import { type SubmitEvent, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { buttonClass, inputClass } from "./styles";

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState("");

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const { error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });

    if (error) {
      setError(error.message ?? "Could not sign in.");
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <input
        name="email"
        type="email"
        placeholder="Email"
        required
        className={inputClass}
      />
      <input
        name="password"
        type="password"
        placeholder="Password"
        required
        className={inputClass}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" className={buttonClass}>
        Sign in
      </button>
    </form>
  );
}
