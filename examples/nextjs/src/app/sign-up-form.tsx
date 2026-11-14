"use client";

import { useRouter } from "next/navigation";
import { type SubmitEvent, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { buttonClass, inputClass } from "./styles";

export function SignUpForm() {
  const router = useRouter();
  const [error, setError] = useState("");

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const { error } = await authClient.signUp.email({
      name: String(form.get("name")),
      email: String(form.get("email")),
      password: String(form.get("password")),
      company: String(form.get("company")),
    });

    if (error) {
      setError(error.message ?? "Could not create the account.");
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <input name="name" placeholder="Name" required className={inputClass} />
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
        placeholder="Password (at least 8 characters)"
        minLength={8}
        required
        className={inputClass}
      />
      <input
        name="company"
        placeholder="Company (optional)"
        className={inputClass}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" className={buttonClass}>
        Create account
      </button>
    </form>
  );
}
