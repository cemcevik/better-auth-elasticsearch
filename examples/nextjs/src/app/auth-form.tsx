"use client";

import { useState } from "react";
import { SignInForm } from "./sign-in-form";
import { SignUpForm } from "./sign-up-form";
import { linkClass } from "./styles";

export function AuthForm() {
  const [showSignUp, setShowSignUp] = useState(false);

  if (showSignUp) {
    return (
      <>
        <SignUpForm />
        <button
          type="button"
          className={linkClass}
          onClick={() => setShowSignUp(false)}
        >
          Already have an account? Sign in
        </button>
      </>
    );
  }

  return (
    <>
      <SignInForm />
      <button
        type="button"
        className={linkClass}
        onClick={() => setShowSignUp(true)}
      >
        No account yet? Create one
      </button>
    </>
  );
}
