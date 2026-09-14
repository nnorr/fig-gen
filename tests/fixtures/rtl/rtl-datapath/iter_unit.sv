`default_nettype none
// Test fixture: a tiny micro-sequenced datapath. Two operands are loaded on
// accept, a step counter selects the adder operands, the sum is written back
// into a temporary register and then into the output register.
module iter_unit (
  input  logic        clk,
  input  logic        rst_n,
  input  logic        in_valid,
  output logic        in_ready,
  input  logic [15:0] operand_a_i,
  input  logic [15:0] operand_b_i,
  output logic        out_valid,
  output logic [15:0] result_o
);
  logic        c_busy, n_busy, c_done, n_done;
  logic [1:0]  c_step, n_step;
  logic [15:0] c_a, n_a, c_b, n_b, c_t, n_t, c_r, n_r;
  logic [15:0] operand_x, operand_y, sum;
  logic        accept;

  assign accept = in_valid && in_ready;
  assign in_ready = !c_busy;
  assign out_valid = c_done;
  assign result_o = c_r;
  assign operand_x = (c_step == 2'd0) ? c_a : c_t;
  assign operand_y = (c_step == 2'd0) ? c_b : c_a;
  assign sum = operand_x + operand_y;

  always_comb begin n_a = c_a; if (accept) n_a = operand_a_i; end
  always_comb begin n_b = c_b; if (accept) n_b = operand_b_i; end
  always_comb begin n_t = c_t; if (c_busy && c_step == 2'd0) n_t = sum; end
  always_comb begin n_r = c_r; if (c_busy && c_step == 2'd1) n_r = sum; end
  always_comb begin
    n_step = c_step;
    if (accept) n_step = 2'd0;
    else if (c_busy) n_step = c_step + 2'd1;
  end
  always_comb begin
    n_busy = c_busy;
    if (accept) n_busy = 1'b1;
    else if (c_busy && c_step == 2'd1) n_busy = 1'b0;
  end
  always_comb begin
    n_done = c_done;
    if (accept) n_done = 1'b0;
    else if (c_busy && c_step == 2'd1) n_done = 1'b1;
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      c_busy <= 1'b0; c_done <= 1'b0; c_step <= 2'd0;
      c_a <= '0; c_b <= '0; c_t <= '0; c_r <= '0;
    end else begin
      c_busy <= n_busy; c_done <= n_done; c_step <= n_step;
      c_a <= n_a; c_b <= n_b; c_t <= n_t; c_r <= n_r;
    end
  end
endmodule
`default_nettype wire
