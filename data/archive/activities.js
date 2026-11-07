const lessonActivities = new Map([
  [
    1,
    {
      legacyResponseTarget: {
        quiz: "quiz-introduction-goal",
        reflection: "reflection-introduction-goal"
      },
      quizzes: [
        {
          id: "quiz-introduction-goal",
          question: "What is a useful first step when learning a new topic?",
          options: [
            "Set a clear learning goal",
            "Memorize every detail immediately",
            "Skip the explanations and start guessing"
          ],
          answer: 0,
          feedback: "A clear goal gives your learning a direction."
        },
        {
          id: "quiz-introduction-review",
          question: "Why is it useful to pause and review a lesson?",
          options: [
            "It helps connect new ideas with what you already know",
            "It guarantees you will never forget the topic",
            "It replaces the need to practice"
          ],
          answer: 0,
          feedback: "Reviewing helps reinforce ideas and connect them with prior knowledge."
        },
        {
          id: "quiz-introduction-practice",
          question: "Which approach is most useful when practicing a new skill?",
          options: [
            "Try it, notice what is difficult, and adjust",
            "Avoid mistakes by never attempting it",
            "Repeat without paying attention to the result"
          ],
          answer: 0,
          feedback: "Practice is most useful when you notice results and adjust your approach."
        },
        {
          id: "quiz-introduction-breaks",
          question: "Why can short breaks help during a study session?",
          options: [
            "They give attention a chance to recover",
            "They automatically teach the material",
            "They remove the need to review"
          ],
          answer: 0,
          feedback: "A brief break can help restore attention before continuing."
        },
        {
          id: "quiz-introduction-explanation",
          question: "What is a useful way to check whether you understand an idea?",
          options: [
            "Explain it in your own words",
            "Recognize the page where it appeared",
            "Read it quickly one more time without thinking"
          ],
          answer: 0,
          feedback: "Explaining an idea in your own words helps reveal what you understand."
        }
      ],
      reflections: [
        {
          id: "reflection-introduction-goal",
          prompt: "What do you hope to understand or be able to do after this course?"
        },
        {
          id: "reflection-introduction-habit",
          prompt: "What is one learning habit that helps you stay curious?"
        }
      ]
    }
  ],
  [
    2,
    {
      legacyResponseTarget: {
        quiz: "quiz-neural-network-weights",
        reflection: "reflection-neural-network-information"
      },
      quizzes: [
        {
          id: "quiz-neural-network-weights",
          question: "What do the connections between neurons in a neural network commonly represent?",
          options: [
            "Adjustable weights that influence signals",
            "A fixed list of answers",
            "The order in which videos are played"
          ],
          answer: 0,
          feedback: "Connection weights influence how signals are passed through the network."
        },
        {
          id: "quiz-neural-network-layers",
          question: "What is a common role of a hidden layer in a neural network?",
          options: [
            "Transforming input signals into useful intermediate representations",
            "Storing a complete copy of every training example",
            "Choosing which video the learner watches next"
          ],
          answer: 0,
          feedback: "Hidden layers transform signals as they move from input toward output."
        },
        {
          id: "quiz-neural-network-neuron",
          question: "What does an artificial neuron typically do with its inputs?",
          options: [
            "Combines them using weights and applies an activation function",
            "Stores them without changing them",
            "Selects a random video"
          ],
          answer: 0,
          feedback: "A neuron combines weighted inputs and applies an activation function."
        },
        {
          id: "quiz-neural-network-training",
          question: "What is a common goal of training a neural network?",
          options: [
            "Adjust its weights to reduce prediction error",
            "Keep every weight fixed from the start",
            "Increase the number of labels in the dataset"
          ],
          answer: 0,
          feedback: "Training adjusts weights so the network's predictions better match its targets."
        },
        {
          id: "quiz-neural-network-output",
          question: "In a supervised classification task, what does the output layer often represent?",
          options: [
            "Scores or probabilities for possible classes",
            "The order the training examples were collected",
            "A copy of the input pixels only"
          ],
          answer: 0,
          feedback: "Classification outputs commonly represent scores or probabilities for classes."
        }
      ],
      reflections: [
        {
          id: "reflection-neural-network-information",
          prompt: "In your own words, how does information move through a neural network?"
        },
        {
          id: "reflection-neural-network-analogy",
          prompt: "What everyday process could you compare to signals being transformed through layers?"
        }
      ]
    }
  ],
  [
    3,
    {
      legacyResponseTarget: {
        quiz: "quiz-attention-context",
        reflection: "reflection-attention-context"
      },
      quizzes: [
        {
          id: "quiz-attention-context",
          question: "What is the main purpose of attention in a sequence model?",
          options: [
            "To weigh which parts of the context are relevant",
            "To remove all earlier words from consideration",
            "To turn text directly into a video"
          ],
          answer: 0,
          feedback: "Attention lets a model weigh context elements differently for a given step."
        },
        {
          id: "quiz-attention-meaning",
          question: "Why can attention help a model interpret a word in a sentence?",
          options: [
            "It can relate the word to other relevant words in context",
            "It assigns every word the same fixed meaning",
            "It removes the sequence order"
          ],
          answer: 0,
          feedback: "Attention helps represent relationships between words in their context."
        },
        {
          id: "quiz-attention-weights",
          question: "What do attention weights indicate?",
          options: [
            "How strongly a position contributes to the current representation",
            "How many layers a model contains",
            "The exact words a user will type next"
          ],
          answer: 0,
          feedback: "Attention weights describe the relative contribution of context positions."
        },
        {
          id: "quiz-attention-query",
          question: "In attention, what does a query help determine?",
          options: [
            "Which keys are relevant for the current information need",
            "The final answer before processing context",
            "How long the input sentence must be"
          ],
          answer: 0,
          feedback: "A query is compared with keys to determine which context information is relevant."
        },
        {
          id: "quiz-attention-context-use",
          question: "Why is attention useful for processing context?",
          options: [
            "It lets the model focus differently depending on the current token",
            "It forces every token to use identical context",
            "It removes all relationships between tokens"
          ],
          answer: 0,
          feedback: "Attention can select different contextual information for different positions."
        }
      ],
      reflections: [
        {
          id: "reflection-attention-context",
          prompt: "Why might the meaning of a word depend on other words around it?"
        },
        {
          id: "reflection-attention-example",
          prompt: "Think of a word whose meaning changes with context. What surrounding clues help clarify it?"
        }
      ]
    }
  ],
  [
    4,
    {
      legacyResponseTarget: {
        quiz: "quiz-llm-next-token",
        reflection: "reflection-llm-verification"
      },
      quizzes: [
        {
          id: "quiz-llm-next-token",
          question: "What does a GPT-style language model generally learn to predict?",
          options: [
            "The next token in a sequence",
            "The author's identity",
            "A video's playback speed"
          ],
          answer: 0,
          feedback: "Next-token prediction is a core training objective for GPT-style language models."
        },
        {
          id: "quiz-llm-context",
          question: "What is the role of context when a language model generates a response?",
          options: [
            "It informs which likely next token fits the current sequence",
            "It guarantees every generated statement is factual",
            "It prevents the model from producing new text"
          ],
          answer: 0,
          feedback: "The context influences which next tokens are likely, but does not guarantee factual accuracy."
        },
        {
          id: "quiz-llm-token",
          question: "What is a token in language-model processing?",
          options: [
            "A unit of text such as a word or word fragment",
            "A guaranteed complete sentence",
            "A score measuring whether a claim is true"
          ],
          answer: 0,
          feedback: "Tokens are text units and may represent words, parts of words, or other symbols."
        },
        {
          id: "quiz-llm-generation",
          question: "How does a text-generating language model commonly produce a response?",
          options: [
            "It predicts and emits tokens sequentially",
            "It retrieves a complete answer in every case",
            "It checks every claim against the internet automatically"
          ],
          answer: 0,
          feedback: "Many generative language models produce text through sequential token prediction."
        },
        {
          id: "quiz-llm-fluency",
          question: "Does fluent language generation guarantee that an answer is true?",
          options: [
            "No, fluency and factual accuracy are different",
            "Yes, fluent responses are always verified",
            "Only if the response is long"
          ],
          answer: 0,
          feedback: "A response can sound fluent while still being inaccurate."
        }
      ],
      reflections: [
        {
          id: "reflection-llm-verification",
          prompt: "What is one reason a plausible-sounding generated answer might still be wrong?"
        },
        {
          id: "reflection-llm-use",
          prompt: "What kind of task would you trust a language model to help with, and what would you verify?"
        }
      ]
    }
  ],
  [
    5,
    {
      legacyResponseTarget: {
        quiz: "quiz-llm-answer-check",
        reflection: "reflection-llm-trust"
      },
      quizzes: [
        {
          id: "quiz-llm-answer-check",
          question: "What is a sensible way to evaluate a language model's answer?",
          options: [
            "Check important claims against reliable sources",
            "Assume fluent writing guarantees accuracy",
            "Use the answer without considering the task"
          ],
          answer: 0,
          feedback: "Fluent output can still contain mistakes, so important claims need verification."
        },
        {
          id: "quiz-llm-limitations",
          question: "Why should important model-generated claims be checked?",
          options: [
            "A confident or fluent answer can still be inaccurate",
            "Models only produce answers when sources are cited",
            "Checking always makes the answer less reliable"
          ],
          answer: 0,
          feedback: "Fluency is not proof of correctness, so important claims need independent checks."
        },
        {
          id: "quiz-llm-sources",
          question: "What is a strong way to verify an important factual claim?",
          options: [
            "Compare it with reliable, relevant sources",
            "Rely only on how confident the response sounds",
            "Assume the first search result must be correct"
          ],
          answer: 0,
          feedback: "Cross-check important claims against reliable sources that directly support them."
        },
        {
          id: "quiz-llm-context-window",
          question: "What can happen when relevant information is missing from a prompt?",
          options: [
            "The model may give an incomplete or unsuitable response",
            "The model automatically finds all missing information",
            "The response is guaranteed to be more accurate"
          ],
          answer: 0,
          feedback: "The model can only use information available to it, so missing context can affect its answer."
        },
        {
          id: "quiz-llm-evaluation",
          question: "Which consideration is useful when evaluating a model's answer?",
          options: [
            "Whether the answer is supported by evidence and fits the task",
            "Whether it uses technical language",
            "Whether it is longer than other answers"
          ],
          answer: 0,
          feedback: "Check evidence and relevance to the task, rather than style or length alone."
        }
      ],
      reflections: [
        {
          id: "reflection-llm-trust",
          prompt: "What question would you ask to check whether a model's explanation is trustworthy?"
        },
        {
          id: "reflection-llm-source",
          prompt: "What sources or evidence would help you verify an important generated answer?"
        }
      ]
    }
  ]
]);
