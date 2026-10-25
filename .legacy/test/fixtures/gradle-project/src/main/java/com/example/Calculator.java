package com.example;

import com.example.MathSupport;

public final class Calculator {
  public int add(int left, int right) { return MathSupport.normalize(left + right); }
}
